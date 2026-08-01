import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../config.js'
import type { PluginWorkloadSdkPromptTarget } from './pluginWorkloadSdkDb.js'

// This is an authorization artifact, not a credential. It binds the exact
// already-authorized target to one invocation so mcp-host cannot be tricked
// into resolving a different slot from a caller-supplied policy response.
export const PLUGIN_SDK_CREDENTIAL_TICKET_AUDIENCE = 'plugin-sdk-credential-broker'
const CREDENTIAL_TICKET_TTL_SECONDS = 60

export type PluginWorkloadSdkCredentialTicketClaims = {
  sub: string
  recipeNamespace: string
  recipeName: string
  invocationId: string
  targetRef: string
  provider: string
  model: string
  credentialSlot: string
  policyRevision: number
  policyHash: string
  typ: 'plugin-sdk-credential-ticket'
}

export function issuePluginWorkloadSdkCredentialTicket(input: {
  recipeNamespace: string
  recipeName: string
  invocationId: string
  target: PluginWorkloadSdkPromptTarget
  policyRevision: number
  policyHash: string
}): string {
  const claims: PluginWorkloadSdkCredentialTicketClaims = {
    sub: `${input.recipeNamespace}/${input.recipeName}`,
    recipeNamespace: input.recipeNamespace,
    recipeName: input.recipeName,
    invocationId: input.invocationId,
    targetRef: input.target.targetRef,
    provider: input.target.provider,
    model: input.target.model,
    credentialSlot: input.target.credentialSlot,
    policyRevision: input.policyRevision,
    policyHash: input.policyHash,
    typ: 'plugin-sdk-credential-ticket',
  }
  return jwt.sign(claims, config.adminJwtPrivateKey, {
    algorithm: 'RS256',
    issuer: config.adminJwtIssuer,
    audience: PLUGIN_SDK_CREDENTIAL_TICKET_AUDIENCE,
    jwtid: randomUUID(),
    expiresIn: CREDENTIAL_TICKET_TTL_SECONDS,
  })
}

export function verifyPluginWorkloadSdkCredentialTicket(
  ticket: string
): PluginWorkloadSdkCredentialTicketClaims | null {
  try {
    const publicKey = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const verified = jwt.verify(ticket, publicKey, {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: PLUGIN_SDK_CREDENTIAL_TICKET_AUDIENCE,
    })
    if (typeof verified !== 'object' || verified === null) return null
    const claims = verified as jwt.JwtPayload
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.recipeNamespace !== 'string' ||
      typeof claims.recipeName !== 'string' ||
      typeof claims.invocationId !== 'string' ||
      typeof claims.targetRef !== 'string' ||
      typeof claims.provider !== 'string' ||
      typeof claims.model !== 'string' ||
      typeof claims.credentialSlot !== 'string' ||
      typeof claims.policyRevision !== 'number' ||
      typeof claims.policyHash !== 'string' ||
      claims.typ !== 'plugin-sdk-credential-ticket'
    ) {
      return null
    }
    return claims as unknown as PluginWorkloadSdkCredentialTicketClaims
  } catch {
    return null
  }
}
