import jwt from 'jsonwebtoken'
import { createHash, createPublicKey } from 'node:crypto'
import { config } from '../config.js'

/**
 * gfs (Global File System) access token.
 *
 * Extends the existing platform JWT system — it is NOT a parallel auth scheme.
 * control-api signs the gfs token with the SAME RS256 keypair it already uses
 * for downstream services (reused from `rpcJwtPrivateKey`); what is new is only
 * the audience (`gfs-controller`) and the `scopes` / `pathBindings` that carry
 * file permissions. gfsc is a downstream verifier (like rpc-proxy / mcp-host):
 * it validates the signature, `aud`, and `exp`, then re-checks the real
 * permissions in the permission store (the source of truth). `pathBindings` are
 * only an upper bound — gfsc re-checks the store on every op, so revocation is
 * immediate, not TTL-bound.
 *
 * The open core reuses ONE platform keypair (no per-drive / per-tenant key
 * material — that is the managed edition, P6).
 */

export const GFS_READ_SCOPE = 'gfs.read'
export const GFS_WRITE_SCOPE = 'gfs.write'
export const GFS_DELETE_SCOPE = 'gfs.delete'
export const GFS_MANAGE_ACL_SCOPE = 'gfs.manage_acl'
export const GFS_SHARE_SCOPE = 'gfs.share'

export const GFS_SCOPES = [
  GFS_READ_SCOPE,
  GFS_WRITE_SCOPE,
  GFS_DELETE_SCOPE,
  GFS_MANAGE_ACL_SCOPE,
  GFS_SHARE_SCOPE,
] as const
export type GfsScope = (typeof GFS_SCOPES)[number]

export type GfsPermission = 'read' | 'write' | 'delete' | 'manage_acl' | 'share'

export interface GfsPathBinding {
  path: string
  permissions: GfsPermission[]
}

export interface GfsTokenClaims extends jwt.JwtPayload {
  sub: string
  drive: string
  scopes: GfsScope[]
  pathBindings: GfsPathBinding[]
  brokeredAuthority?: GfsBrokeredAuthority
  principalType?: 'user' | 'control-admin'
}

export interface GfsBrokeredAuthority {
  desktopUserId: string
  controlAdminId: string
  authoritySource: 'linked-admin'
}

/**
 * `kid` for the gfs token. The open core reuses a single platform keypair, so
 * there is no externally-assigned key id. We derive a stable, content-addressed
 * id — the RFC 7638 JWK thumbprint of the RS256 public key — rather than invent
 * an arbitrary value. gfsc verifies sig/aud/exp with its one configured public
 * key; the `kid` is informational in the core and forward-compatible with the
 * managed edition's per-tenant, kid-selected trust store (P6).
 */
let cachedKid: string | null = null
export function gfsSigningKeyId(): string {
  if (cachedKid) return cachedKid
  const jwk = createPublicKey(config.rpcJwtPrivateKey).export({ format: 'jwk' }) as {
    kty: string
    n: string
    e: string
  }
  // RFC 7638: required members only, lexicographic order, no whitespace.
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })
  cachedKid = createHash('sha256').update(canonical).digest('base64url')
  return cachedKid
}

/**
 * Sign a short-lived gfs access token for a principal (`sub` is a userId or a
 * host identity — never an operator/team/context, which are groups resolved to
 * principals at check time). The signature, audience, issuer, and TTL mirror
 * the existing wfc/rpc token path exactly.
 */
export function signGfsToken(input: {
  subject: string
  drive: string
  scopes: readonly GfsScope[]
  pathBindings?: readonly GfsPathBinding[]
  brokeredAuthority?: GfsBrokeredAuthority
  principalType?: 'user' | 'control-admin'
}): { token: string; expiresInSeconds: number } {
  const claims: Omit<GfsTokenClaims, 'iat' | 'exp'> = {
    sub: input.subject,
    drive: input.drive,
    scopes: [...input.scopes],
    pathBindings: input.pathBindings ? input.pathBindings.map(b => ({ ...b })) : [],
    ...(input.brokeredAuthority ? { brokeredAuthority: { ...input.brokeredAuthority } } : {}),
    ...(input.principalType ? { principalType: input.principalType } : {}),
  }
  const token = jwt.sign(claims, config.rpcJwtPrivateKey, {
    algorithm: 'RS256',
    issuer: config.rpcJwtIssuer,
    audience: config.gfsTokenAudience,
    expiresIn: config.gfsTokenTtlSeconds,
    keyid: gfsSigningKeyId(),
  })
  return { token, expiresInSeconds: config.gfsTokenTtlSeconds }
}
