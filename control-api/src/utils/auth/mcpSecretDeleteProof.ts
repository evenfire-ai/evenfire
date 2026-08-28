import { createHmac, timingSafeEqual } from 'node:crypto'

export const MCP_SECRET_DELETE_PROOF_TTL_SECONDS = 120

export type McpSecretDeleteProofInput = {
  name: string
  namespace: string
  uid: string
  resourceVersion: string
}

export type McpSecretDeleteProofClaims = McpSecretDeleteProofInput & {
  exp: number
}

const CLAIM_KEYS = ['name', 'namespace', 'uid', 'resourceVersion', 'exp'] as const
const COOKIE_NAME_PREFIX = 'mcp_secret_delete_proof_'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function encodeClaims(claims: McpSecretDeleteProofClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
}

function sign(encodedClaims: string, sessionKey: string): Buffer {
  return createHmac('sha256', sessionKey).update(encodedClaims, 'utf8').digest()
}

function parseClaims(encodedClaims: string): McpSecretDeleteProofClaims | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encodedClaims)) return null

  let raw: unknown
  try {
    const decoded = Buffer.from(encodedClaims, 'base64url')
    if (decoded.toString('base64url') !== encodedClaims) return null
    raw = JSON.parse(decoded.toString('utf8'))
  } catch {
    return null
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const claims = raw as Record<string, unknown>
  if (
    Object.keys(claims).length !== CLAIM_KEYS.length ||
    !CLAIM_KEYS.every(key => Object.prototype.hasOwnProperty.call(claims, key)) ||
    !isNonEmptyString(claims.name) ||
    !isNonEmptyString(claims.namespace) ||
    !isNonEmptyString(claims.uid) ||
    !isNonEmptyString(claims.resourceVersion) ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp)
  ) {
    return null
  }

  return {
    name: claims.name,
    namespace: claims.namespace,
    uid: claims.uid,
    resourceVersion: claims.resourceVersion,
    exp: claims.exp,
  }
}

export function mcpSecretDeleteProofCookieName(name: string): string {
  return `${COOKIE_NAME_PREFIX}${Buffer.from(name, 'utf8').toString('base64url')}`
}

export function createMcpSecretDeleteProof(
  input: McpSecretDeleteProofInput,
  sessionKey: string
): string {
  if (!sessionKey) throw new Error('Admin session is required to issue an MCP Secret delete proof')

  const claims: McpSecretDeleteProofClaims = {
    name: input.name,
    namespace: input.namespace,
    uid: input.uid,
    resourceVersion: input.resourceVersion,
    exp: Math.floor(Date.now() / 1000) + MCP_SECRET_DELETE_PROOF_TTL_SECONDS,
  }
  const encodedClaims = encodeClaims(claims)
  return `${encodedClaims}.${sign(encodedClaims, sessionKey).toString('base64url')}`
}

export function verifyMcpSecretDeleteProof(
  proof: string,
  sessionKey: string
): McpSecretDeleteProofClaims | null {
  if (!proof || !sessionKey) return null

  const [encodedClaims, encodedSignature, ...rest] = proof.split('.')
  if (
    !encodedClaims ||
    !encodedSignature ||
    rest.length > 0 ||
    !/^[A-Za-z0-9_-]+$/.test(encodedSignature)
  ) {
    return null
  }

  const claims = parseClaims(encodedClaims)
  if (!claims) return null

  let suppliedSignature: Buffer
  try {
    suppliedSignature = Buffer.from(encodedSignature, 'base64url')
  } catch {
    return null
  }
  const expectedSignature = sign(encodedClaims, sessionKey)
  if (
    suppliedSignature.length !== expectedSignature.length ||
    suppliedSignature.toString('base64url') !== encodedSignature ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null
  }

  if (claims.exp <= Math.floor(Date.now() / 1000)) return null
  return claims
}
