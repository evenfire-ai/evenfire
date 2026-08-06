import { config } from '../../config.js'
import { identityProviderError } from './errors.js'
import type { IdentityProviderLoginFlow } from './types.js'

export const CANONICAL_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FLOW_BINDING_RE = /^[A-Za-z0-9_-]{43,128}$/

function normalizedOrigin(url: URL): string {
  const hostname = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ? 'loopback'
    : url.hostname
  return `${url.protocol}//${hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
}

function allowedWebReturnUrl(flow: IdentityProviderLoginFlow): URL {
  const base = flow === 'admin_connect' ? config.controlUiBaseUrl : config.desktopProfileUiBaseUrl
  try {
    return new URL(base)
  } catch {
    throw identityProviderError(500, 'Identity provider return URL allowlist is invalid')
  }
}

export function validateIdentityProviderReturnUrl(
  flow: IdentityProviderLoginFlow,
  rawReturnUrl: string
): string {
  const value = rawReturnUrl.trim()
  if (flow === 'desktop_login') {
    if (value !== 'evenfire://auth/microsoft/callback') {
      throw identityProviderError(400, 'Invalid desktop return URL')
    }
    return value
  }

  let candidate: URL
  try {
    candidate = new URL(value)
  } catch {
    throw identityProviderError(400, 'Invalid return URL')
  }
  if (
    !['http:', 'https:'].includes(candidate.protocol) ||
    candidate.username ||
    candidate.password ||
    candidate.hash
  ) {
    throw identityProviderError(400, 'Invalid return URL')
  }

  const allowed = allowedWebReturnUrl(flow)
  if (normalizedOrigin(candidate) !== normalizedOrigin(allowed)) {
    throw identityProviderError(400, 'Return URL origin is not allowed')
  }
  const requiredPath =
    flow === 'admin_connect'
      ? '/settings/integrations/microsoft/connect'
      : '/auth/provider-callback'
  if (candidate.pathname.replace(/\/+$/, '') !== requiredPath) {
    throw identityProviderError(400, 'Return URL path is not allowed')
  }
  return candidate.toString()
}

export function requireFlowBinding(flow: IdentityProviderLoginFlow, value: string): string | null {
  if (flow === 'admin_connect') return null
  const normalized = value.trim()
  if (!FLOW_BINDING_RE.test(normalized)) {
    throw identityProviderError(400, 'A valid identity provider flow binding is required')
  }
  return normalized
}

export function requireCanonicalGuid(value: string, fieldName: string): string {
  const normalized = value.trim().toLowerCase()
  if (!CANONICAL_GUID_RE.test(normalized)) {
    throw identityProviderError(400, `${fieldName} must be a canonical UUID`)
  }
  return normalized
}

export function identityProviderCallbackErrorMessage(code: string): string {
  return code === 'unauthorized_microsoft_account'
    ? 'This Microsoft account is not authorized for this Evenfire organization.'
    : 'Microsoft sign-in could not be completed.'
}
