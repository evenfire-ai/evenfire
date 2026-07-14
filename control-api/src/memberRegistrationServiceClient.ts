import { config } from './config.js'
import { signMemberRegistrationJwt } from './utils/auth/memberRegistrationSigner.js'

type RequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

function buildUrl(path: string): string {
  const base = config.memberRegistrationServiceBaseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalizedPath}`
}

export async function memberRegistrationServiceRequest<T>(
  method: RequestMethod,
  path: string,
  options?: {
    body?: unknown
  }
): Promise<T> {
  const response = await fetch(buildUrl(path), {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${signMemberRegistrationJwt()}`,
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
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
