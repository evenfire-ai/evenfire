import { config } from './config.js'
import { rootLogger } from './observability/logger.js'
import {
  ensureEnrollment,
  normalizeEnrollmentHost,
} from './services/memberRegistrationEnrollment.js'
import { MemberRegistrationUnavailableError } from './services/memberRegistrationErrors.js'
import {
  type MemberRegistrationSigningCredential,
  signMemberRegistrationJwt,
} from './utils/auth/memberRegistrationSigner.js'

type RequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

// Bounds a stalled hub (otherwise the request hangs indefinitely). Must stay
// below control-ui's API_REQUEST_TIMEOUT_MS (30000), otherwise the browser
// aborts first and shows "Request timed out. Check that Control API is
// reachable" (blaming the wrong component) instead of
// member_registration_unavailable. Leaving headroom lets the 503 reach the
// browser. Also larger than enrollment path's MINT_TIMEOUT_MS (10_000,
// memberRegistrationEnrollment.ts) to give a loaded SMTP send room. Tradeoff:
// if the hub's send exceeds this timeout, we abort and return 503 while the
// hub may have already sent the mail, leaving the invitation in draft
// (cleanupStaleDraftInvitations later deletes it).
const SEND_TIMEOUT_MS = 20_000

function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalizedPath}`
}

// The single mode seam (spec §8.5): remote signs with the injected env
// credential against the configured service; hosted resolves the credential
// bound to the DESTINATION host (the hub 403s on any mismatch) and calls the
// external hub. destinationBaseUrl is required so no call site can silently
// sign with the wrong credential.
async function resolveTarget(destinationBaseUrl: string): Promise<{
  baseUrl: string
  credential: MemberRegistrationSigningCredential
}> {
  if (config.memberRegistrationMode === 'hosted') {
    // Hosted mode deliberately ignores config.memberRegistrationServiceBaseUrl /
    // *HmacSecret / *HmacKid / *TenantId (the `remote` branch below). Those fields
    // still exist because they serve a self-hosted operator pointing control-api at
    // their OWN member-registration-service; hosted instead enrolls a per-destination
    // credential against the shared external hub and signs with that.
    const credential = await ensureEnrollment(normalizeEnrollmentHost(destinationBaseUrl))
    return {
      baseUrl: config.memberRegistrationExternalHubBaseUrl,
      credential: {
        secret: credential.secret,
        kid: credential.kid,
        tenantId: credential.tenantId,
      },
    }
  }
  return {
    baseUrl: config.memberRegistrationServiceBaseUrl,
    credential: {
      secret: config.memberRegistrationServiceHmacSecret,
      kid: config.memberRegistrationServiceHmacKid,
      tenantId: config.memberRegistrationTenantId,
    },
  }
}

// Log hygiene (mirrors memberRegistrationEnrollment.ts:100): status only —
// never stringify the upstream response body into the log or the error.
function unavailable(
  context: { baseUrl: string; method: string; path: string; upstreamStatus?: number },
  message: string,
  cause?: unknown
): MemberRegistrationUnavailableError {
  rootLogger.error(
    {
      event: 'member_registration_request_failed',
      ...context,
      cause: cause instanceof Error ? cause.message : undefined,
    },
    message
  )
  return new MemberRegistrationUnavailableError(message)
}

export async function memberRegistrationServiceRequest<T>(
  method: RequestMethod,
  path: string,
  options: {
    body?: unknown
    destinationBaseUrl: string
  }
): Promise<T> {
  const { baseUrl, credential } = await resolveTarget(options.destinationBaseUrl)
  const context = { baseUrl, method, path }

  let response: Response
  try {
    response = await fetch(buildUrl(baseUrl, path), {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${signMemberRegistrationJwt(credential)}`,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch (cause) {
    throw unavailable(context, 'member-registration service is unreachable', cause)
  }

  // Upstream 5xx is an availability problem: typed, so the app.ts middleware
  // returns 503. 4xx is a domain answer from the hub and keeps the legacy
  // message verbatim — `Member registration service` and `(status)` are matched
  // by routes/external/invitations.ts:212, routes/admin/teams.ts:42 and
  // routes/external/teams.ts:36 (spec §4.1).
  if (response.status >= 500) {
    // NOTE: this message must NOT contain the exact string "Member registration
    // service" (capital M) — that exact string is reserved for the untyped 4xx
    // path below, which the sendInvitationServiceError helpers
    // (routes/admin/teams.ts:42, routes/external/teams.ts:36) match on.
    throw unavailable(
      { ...context, upstreamStatus: response.status },
      `member-registration service ${method} ${path} failed (${response.status})`
    )
  }

  // A stalled body (headers sent, body never completes) or a mid-body reset
  // throws here (raw AbortError / TypeError: terminated) even though the
  // fetch() above already resolved. Without this try/catch that throw escapes
  // untyped and collapses to a generic 500 — the exact failure this file
  // exists to prevent.
  let raw: string
  try {
    raw = await response.text()
  } catch (cause) {
    throw unavailable(
      { ...context, upstreamStatus: response.status },
      'member-registration service response could not be read',
      cause
    )
  }

  let parsed: unknown = null
  let nonJsonBody = false
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (cause) {
      if (response.ok) {
        // The parse error is NOT passed as cause here: V8 embeds ~10 chars of
        // the offending input in SyntaxError.message, so passing cause would
        // leak the upstream body into the log — contradicting this file's
        // status-only rule (line 53). The message + upstreamStatus is sufficient.
        throw unavailable(
          { ...context, upstreamStatus: response.status },
          'member-registration service returned a non-JSON response'
        )
      }
      nonJsonBody = true
      parsed = null
    }
  }

  if (!response.ok) {
    // A non-JSON 4xx body must never be interpolated verbatim: it's echoed to
    // callers by routes/admin/teams.ts:44, so an intermediary's HTML error
    // page (possibly containing internal hostnames) must not leak through.
    let errorMessage = nonJsonBody
      ? '<non-JSON response>'
      : parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : raw
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      errorMessage = `${errorMessage}: ${String((parsed as { message: unknown }).message)}`
    }
    throw new Error(
      `Member registration service ${method} ${path} failed (${response.status}): ${errorMessage}`
    )
  }

  return parsed as T
}
