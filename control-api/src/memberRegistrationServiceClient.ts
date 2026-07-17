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

const SEND_TIMEOUT_MS = 10_000

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
    throw unavailable(
      { ...context, upstreamStatus: response.status },
      `member-registration service ${method} ${path} failed (${response.status})`
    )
  }

  const raw = await response.text()
  let parsed: unknown = null
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (cause) {
      if (response.ok) {
        throw unavailable(
          { ...context, upstreamStatus: response.status },
          'member-registration service returned a non-JSON response',
          cause
        )
      }
      parsed = null
    }
  }

  if (!response.ok) {
    let errorMessage =
      parsed && typeof parsed === 'object' && 'error' in parsed
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
