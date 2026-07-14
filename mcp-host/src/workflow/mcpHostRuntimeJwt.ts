import { decodeJwt } from 'jose'

export type RuntimeJwtBinding = {
  hostRef: string
  recipeNamespace: string
  recipeName: string
}

type RuntimeJwtClaims = {
  sub?: unknown
  hostRefs?: unknown
  recipeNamespace?: unknown
  recipeName?: unknown
  exp?: unknown
  iat?: unknown
}

export type DecodedRuntimeJwtClaims = {
  callerKey: string | null
  hostRef: string | null
  recipeNamespace: string | null
  recipeName: string | null
  exp: number | null
  iat: number | null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function emptyRuntimeClaims(): DecodedRuntimeJwtClaims {
  return {
    callerKey: null,
    hostRef: null,
    recipeNamespace: null,
    recipeName: null,
    exp: null,
    iat: null,
  }
}

/**
 * Decode mcp-host runtime JWT claims for local metadata only.
 *
 * This function is deliberately not an authorization boundary: control-api
 * verifies the bearer token, scopes, issuer, audience, and hostRefs on every
 * request. mcp-host uses this unverified decode only to stamp approvals,
 * workflow trigger metadata, persisted runtime bindings, and usage events with
 * the same canonical caller key that control-api will enforce.
 *
 * Per the workflow auth contract, hostRefs[0] is the canonical caller/usage
 * binding for mcp-host-control flows. sub is not a caller fallback.
 */
export function decodeMcpHostRuntimeJwtClaims(token: string): DecodedRuntimeJwtClaims {
  try {
    const payload = decodeJwt(token) as RuntimeJwtClaims
    const hostRefs = Array.isArray(payload.hostRefs) ? payload.hostRefs : []
    const primaryHostRef = nonEmptyString(hostRefs[0])
    const exp = typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null
    const iat = typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : null

    return {
      callerKey: primaryHostRef,
      hostRef: primaryHostRef,
      recipeNamespace: nonEmptyString(payload.recipeNamespace),
      recipeName: nonEmptyString(payload.recipeName),
      exp,
      iat,
    }
  } catch {
    return emptyRuntimeClaims()
  }
}

export function getMcpHostRuntimeCallerKey(token: string): string | null {
  return decodeMcpHostRuntimeJwtClaims(token).callerKey
}

export function getJwtExpiry(token: string): number | null {
  return decodeMcpHostRuntimeJwtClaims(token).exp
}

export function getJwtIssuedAt(token: string): number | null {
  return decodeMcpHostRuntimeJwtClaims(token).iat
}

export function getJwtRuntimeBinding(token: string): RuntimeJwtBinding | null {
  const claims = decodeMcpHostRuntimeJwtClaims(token)
  if (!claims.hostRef || !claims.recipeNamespace || !claims.recipeName) {
    return null
  }
  return {
    hostRef: claims.hostRef,
    recipeNamespace: claims.recipeNamespace,
    recipeName: claims.recipeName,
  }
}
