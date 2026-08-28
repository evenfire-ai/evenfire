import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

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
const PROOF_VERSION = 'v1'
const PROOF_ALGORITHM = 'aes-256-gcm'
const PROOF_IV_BYTES = 12

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function proofKey(sessionKey: string): Buffer {
  return createHash('sha256')
    .update('evenfire:mcp-secret-delete-proof:v1\0', 'utf8')
    .update(sessionKey, 'utf8')
    .digest()
}

function parseClaims(plaintext: Buffer): McpSecretDeleteProofClaims | null {
  let raw: unknown
  try {
    raw = JSON.parse(plaintext.toString('utf8'))
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

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.toString('base64url') === value ? decoded : null
  } catch {
    return null
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
  const iv = randomBytes(PROOF_IV_BYTES)
  const cipher = createCipheriv(PROOF_ALGORITHM, proofKey(sessionKey), iv)
  cipher.setAAD(Buffer.from(PROOF_VERSION, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()])
  return [
    PROOF_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
}

export function verifyMcpSecretDeleteProof(
  proof: string,
  sessionKey: string
): McpSecretDeleteProofClaims | null {
  if (!proof || !sessionKey) return null

  const [version, encodedIv, encodedCiphertext, encodedAuthTag, ...rest] = proof.split('.')
  if (version !== PROOF_VERSION || rest.length > 0) return null
  const iv = decodeCanonicalBase64Url(encodedIv)
  const ciphertext = decodeCanonicalBase64Url(encodedCiphertext)
  const authTag = decodeCanonicalBase64Url(encodedAuthTag)
  if (!iv || iv.length !== PROOF_IV_BYTES || !ciphertext || !authTag) return null

  let claims: McpSecretDeleteProofClaims | null
  try {
    const decipher = createDecipheriv(PROOF_ALGORITHM, proofKey(sessionKey), iv)
    decipher.setAAD(Buffer.from(PROOF_VERSION, 'utf8'))
    decipher.setAuthTag(authTag)
    claims = parseClaims(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  } catch {
    return null
  }
  if (!claims || claims.exp <= Math.floor(Date.now() / 1000)) return null
  return claims
}
