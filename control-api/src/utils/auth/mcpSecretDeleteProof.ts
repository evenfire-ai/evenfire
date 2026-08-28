import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import { config } from '../../config.js'

export const MCP_SECRET_DELETE_PROOF_TTL_SECONDS = 120

export type McpSecretDeleteProofInput = {
  name: string
  namespace: string
  uid: string
  resourceVersion: string
  sessionJti: string
}

export type McpSecretDeleteProofClaims = McpSecretDeleteProofInput & {
  exp: number
}

const COOKIE_NAME_PREFIX = 'mcp_secret_delete_proof_'
const PROOF_AUDIENCE = 'control-api:mcp-secret-delete'
const PROOF_ISSUER = 'control-api'
const PROOF_KIND = 'mcp-secret-delete-proof'
const sessionJwtPublicKey = createPublicKey(config.sessionJwtPrivateKey).export({
  type: 'spki',
  format: 'pem',
})

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function mcpSecretDeleteProofCookieName(name: string): string {
  return `${COOKIE_NAME_PREFIX}${Buffer.from(name, 'utf8').toString('base64url')}`
}

export function createMcpSecretDeleteProof(input: McpSecretDeleteProofInput): string {
  if (
    !isNonEmptyString(input.name) ||
    !isNonEmptyString(input.namespace) ||
    !isNonEmptyString(input.uid) ||
    !isNonEmptyString(input.resourceVersion) ||
    !isNonEmptyString(input.sessionJti)
  ) {
    throw new Error('A complete admin session and Secret identity are required for rollback proof')
  }

  return jwt.sign(
    {
      tokenKind: PROOF_KIND,
      name: input.name,
      namespace: input.namespace,
      uid: input.uid,
      resourceVersion: input.resourceVersion,
      sessionJti: input.sessionJti,
    },
    config.sessionJwtPrivateKey,
    {
      algorithm: 'RS256',
      audience: PROOF_AUDIENCE,
      issuer: PROOF_ISSUER,
      expiresIn: MCP_SECRET_DELETE_PROOF_TTL_SECONDS,
    }
  )
}

export function verifyMcpSecretDeleteProof(proof: string): McpSecretDeleteProofClaims | null {
  if (!proof) return null

  try {
    const payload = jwt.verify(proof, sessionJwtPublicKey, {
      algorithms: ['RS256'],
      audience: PROOF_AUDIENCE,
      issuer: PROOF_ISSUER,
    })
    if (
      typeof payload === 'string' ||
      payload.tokenKind !== PROOF_KIND ||
      !isNonEmptyString(payload.name) ||
      !isNonEmptyString(payload.namespace) ||
      !isNonEmptyString(payload.uid) ||
      !isNonEmptyString(payload.resourceVersion) ||
      !isNonEmptyString(payload.sessionJti) ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.exp)
    ) {
      return null
    }
    return {
      name: payload.name,
      namespace: payload.namespace,
      uid: payload.uid,
      resourceVersion: payload.resourceVersion,
      sessionJti: payload.sessionJti,
      exp: payload.exp,
    }
  } catch {
    return null
  }
}
