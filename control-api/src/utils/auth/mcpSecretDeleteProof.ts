import { createHash, timingSafeEqual } from 'node:crypto'

export const MCP_SECRET_DELETE_PROOF_TTL_SECONDS = 120

export type McpSecretDeleteProofInput = {
  name: string
  namespace: string
  uid: string
  resourceVersion: string
  sessionJti: string
}

export type McpSecretDeleteProofVerification = 'valid' | 'identity-mismatch' | null

const COOKIE_NAME_PREFIX = 'mcp_secret_delete_proof_'
const PROOF_VERSION = 'v1'
const DIGEST_RE = /^[a-f0-9]{64}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function digestParts(...parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, 'utf8')), 'utf8')
    hash.update(':', 'utf8')
    hash.update(part, 'utf8')
    hash.update('|', 'utf8')
  }
  return hash.digest('hex')
}

function identityDigest(input: Pick<McpSecretDeleteProofInput, 'uid' | 'resourceVersion'>): string {
  return digestParts(PROOF_VERSION, input.uid, input.resourceVersion)
}

function proofDigest(
  input: McpSecretDeleteProofInput,
  expiresAt: number,
  boundIdentityDigest: string
): string {
  return digestParts(
    PROOF_VERSION,
    input.sessionJti,
    input.name,
    input.namespace,
    boundIdentityDigest,
    String(expiresAt)
  )
}

function sameDigest(left: string, right: string): boolean {
  if (!DIGEST_RE.test(left) || !DIGEST_RE.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function hasCompleteInput(input: McpSecretDeleteProofInput): boolean {
  return (
    isNonEmptyString(input.name) &&
    isNonEmptyString(input.namespace) &&
    isNonEmptyString(input.uid) &&
    isNonEmptyString(input.resourceVersion) &&
    isNonEmptyString(input.sessionJti)
  )
}

export function mcpSecretDeleteProofCookieName(name: string): string {
  return `${COOKIE_NAME_PREFIX}${Buffer.from(name, 'utf8').toString('base64url')}`
}

export function createMcpSecretDeleteProof(input: McpSecretDeleteProofInput): string {
  if (!hasCompleteInput(input)) {
    throw new Error('A complete admin session and Secret identity are required for rollback proof')
  }
  const expiresAt = Math.floor(Date.now() / 1000) + MCP_SECRET_DELETE_PROOF_TTL_SECONDS
  const boundIdentityDigest = identityDigest(input)
  return [expiresAt, boundIdentityDigest, proofDigest(input, expiresAt, boundIdentityDigest)].join(
    '.'
  )
}

export function verifyMcpSecretDeleteProof(
  proof: string,
  input: McpSecretDeleteProofInput
): McpSecretDeleteProofVerification {
  if (!proof || !hasCompleteInput(input)) return null
  const [encodedExpiry, boundIdentityDigest, suppliedProofDigest, ...rest] = proof.split('.')
  if (
    rest.length > 0 ||
    !/^\d+$/.test(encodedExpiry) ||
    !DIGEST_RE.test(boundIdentityDigest) ||
    !DIGEST_RE.test(suppliedProofDigest)
  ) {
    return null
  }
  const expiresAt = Number(encodedExpiry)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null
  if (!sameDigest(boundIdentityDigest, identityDigest(input))) return 'identity-mismatch'
  return sameDigest(suppliedProofDigest, proofDigest(input, expiresAt, boundIdentityDigest))
    ? 'valid'
    : null
}
