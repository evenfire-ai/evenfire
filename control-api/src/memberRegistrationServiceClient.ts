import { config } from './config.js'
import {
  signMemberRegistrationJwt,
  type MemberRegistrationSigningCredential,
} from './utils/auth/memberRegistrationSigner.js'
import {
  ensureEnrollment,
  normalizeEnrollmentHost,
} from './services/memberRegistrationEnrollment.js'

type RequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

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

export async function memberRegistrationServiceRequest<T>(
  method: RequestMethod,
  path: string,
  options: {
    body?: unknown
    destinationBaseUrl: string
  }
): Promise<T> {
  const { baseUrl, credential } = await resolveTarget(options.destinationBaseUrl)
  const response = await fetch(buildUrl(baseUrl, path), {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${signMemberRegistrationJwt(credential)}`,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

  const raw = await response.text()
  const parsed = raw ? (JSON.parse(raw) as unknown) : null

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
