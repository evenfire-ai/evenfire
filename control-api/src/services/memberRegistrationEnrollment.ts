import { config } from '../config.js'
import { rootLogger } from '../observability/logger.js'
import {
  MemberRegistrationMisconfiguredError,
  MemberRegistrationUnavailableError,
} from './memberRegistrationErrors.js'
import {
  getActiveMemberRegistrationCredential,
  insertMemberRegistrationCredential,
  type MemberRegistrationCredential,
} from './memberRegistrationCredentialsDb.js'

// Hosted-mode self-enrollment against the shared hub (spec §8.3/§8.4).
// Lock-free: in-flight promise map (per-replica) + the partial unique index
// with adopt-winner (cross-replica). NO transaction or advisory lock may span
// the mint fetch. Log hygiene: never log the secret or a raw mint body.
const MINT_TIMEOUT_MS = 10_000
const HUB_REJECTION_TTL_MS = 10 * 60 * 1000
const BACKOFF_BASE_MS = 5_000
const BACKOFF_CAP_MS = 5 * 60 * 1000

const inFlight = new Map<string, Promise<MemberRegistrationCredential>>()
const negativeCache = new Map<string, { until: number; message: string }>()
const consecutiveTransientFailures = new Map<string, number>()

export function __resetMemberRegistrationEnrollmentForTests(): void {
  inFlight.clear()
  negativeCache.clear()
  consecutiveTransientFailures.clear()
}

export function normalizeEnrollmentHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    throw new MemberRegistrationMisconfiguredError(
      `member-registration destination is not a valid URL: ${baseUrl}`
    )
  }
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

function assertEnrollableHost(host: string): void {
  const reason =
    host === 'localhost' || host.endsWith('.localhost')
      ? 'localhost'
      : IPV4_RE.test(host)
        ? 'an IPv4 literal'
        : host.startsWith('[') || host.includes(':')
          ? 'an IPv6 literal'
          : !host.includes('.')
            ? 'a dotless hostname'
            : null
  if (reason) {
    throw new MemberRegistrationMisconfiguredError(
      `hosted member-registration requires a real, publicly resolvable domain — '${host}' is ${reason}. Set CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL / CONTROL_API_CONTROL_UI_BASE_URL to real domains.`
    )
  }
}

function hubOrigin(): string {
  return new URL(config.memberRegistrationExternalHubBaseUrl).origin
}

export async function ensureEnrollment(domain: string): Promise<MemberRegistrationCredential> {
  assertEnrollableHost(domain)
  const cached = negativeCache.get(domain)
  if (cached) {
    if (cached.until > Date.now()) throw new MemberRegistrationUnavailableError(cached.message)
    negativeCache.delete(domain)
  }
  const pending = inFlight.get(domain)
  if (pending) return pending
  const attempt = enroll(domain).finally(() => inFlight.delete(domain))
  inFlight.set(domain, attempt)
  return attempt
}

async function enroll(domain: string): Promise<MemberRegistrationCredential> {
  const existing = await getActiveMemberRegistrationCredential(domain)
  if (existing) return existing

  let response: Response
  try {
    response = await fetch(`${hubOrigin()}/public/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    })
  } catch (error) {
    throw transientFailure(
      domain,
      `member-registration hub unreachable: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!response.ok) {
    // Log hygiene: status only — never stringify the response body.
    if (response.status >= 400 && response.status < 500) {
      const message = `member-registration hub rejected enrollment for '${domain}' (${response.status})`
      negativeCache.set(domain, { until: Date.now() + HUB_REJECTION_TTL_MS, message })
      rootLogger.error(
        { event: 'member_registration_enrollment_rejected', domain, status: response.status },
        message
      )
      throw new MemberRegistrationUnavailableError(message)
    }
    throw transientFailure(domain, `member-registration hub error (${response.status})`)
  }

  consecutiveTransientFailures.delete(domain)
  const minted = (await response.json()) as { tenantId?: unknown; kid?: unknown; secret?: unknown }
  if (
    typeof minted.tenantId !== 'string' ||
    typeof minted.kid !== 'string' ||
    typeof minted.secret !== 'string'
  ) {
    throw transientFailure(domain, 'member-registration hub returned a malformed mint response')
  }

  const { inserted } = await insertMemberRegistrationCredential({
    boundDomain: domain,
    tenantId: minted.tenantId,
    kid: minted.kid,
    secret: minted.secret,
  })
  const winner = await getActiveMemberRegistrationCredential(domain)
  if (!winner) {
    throw transientFailure(domain, 'credential row missing after insert')
  }
  if (!inserted) {
    rootLogger.warn(
      {
        event: 'member_registration_enrollment_orphan',
        domain,
        kid: winner.kid,
        tenantId: winner.tenantId,
      },
      'lost the cross-replica mint race; adopting the winning credential (orphan minted hub-side)'
    )
  } else {
    rootLogger.info(
      { event: 'member_registration_enrolled', domain, kid: winner.kid, tenantId: winner.tenantId },
      'enrolled with the member-registration hub'
    )
  }
  return winner
}

function transientFailure(domain: string, message: string): MemberRegistrationUnavailableError {
  const failures = (consecutiveTransientFailures.get(domain) ?? 0) + 1
  consecutiveTransientFailures.set(domain, failures)
  const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS)
  negativeCache.set(domain, { until: Date.now() + backoffMs, message })
  rootLogger.error(
    { event: 'member_registration_enrollment_failed', domain, failures, backoffMs },
    message
  )
  return new MemberRegistrationUnavailableError(message)
}

// Boot hook (spec §8.4): exported and unit-testable; contract = never rejects.
// main.ts only calls this — do NOT inline a try/catch there.
export async function runBootEnrollment(): Promise<void> {
  if (config.memberRegistrationMode !== 'hosted') return
  const hosts = new Set<string>()
  for (const base of [config.desktopProfileUiBaseUrl, config.controlUiBaseUrl]) {
    try {
      hosts.add(normalizeEnrollmentHost(base))
    } catch (error) {
      rootLogger.error(
        { event: 'member_registration_boot_enrollment_failed', base },
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  for (const host of hosts) {
    try {
      await ensureEnrollment(host)
    } catch (error) {
      rootLogger.error(
        { event: 'member_registration_boot_enrollment_failed', domain: host },
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}
