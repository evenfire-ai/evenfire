import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { config } from '../../config.js'

export const WFC_BROWSING_READ_SCOPE = 'files:read'
export const WFC_BROWSING_WRITE_SCOPE = 'files:write'
export const WFC_BROWSING_SCOPES = [WFC_BROWSING_READ_SCOPE, WFC_BROWSING_WRITE_SCOPE] as const
export type WfcBrowsingScope = (typeof WFC_BROWSING_SCOPES)[number]

/**
 * Browsing JWTs are short-lived bearer tokens that the Control UI presents
 * to a per-SharedFileSystem workspace-files-controller. The wfc verifies:
 *   - iss matches CONTROL_API_RPC_JWT_ISSUER (default "control-api")
 *   - aud matches CONTROL_API_WFC_JWT_AUDIENCE (default "workspace-files-controller")
 *   - sharedFileSystem claim matches that wfc's WSF_SHARED_FILESYSTEM_NAME
 *   - scopes explicitly permit file read/write operations
 *   - exp is in the future
 *
 * The signing key is the same RS256 keypair used for RPC tokens, so the
 * cluster only has to manage one public key (already wired into mcp-host-config
 * for the rpc-proxy → mcp-host chain). Audience separation is enough to keep
 * RPC tokens out of the wfc and vice versa — see wfc/src/auth/jwtVerifier.ts.
 */
export interface WfcBrowsingClaims extends jwt.JwtPayload {
  sub: string
  sharedFileSystem: string
  sharedFileSystemNamespace: string
  scopes: WfcBrowsingScope[]
  jti: string
}

export function signWfcBrowsingToken(input: {
  subject: string
  sharedFileSystem: string
  sharedFileSystemNamespace: string
  scopes?: readonly WfcBrowsingScope[]
}): { token: string; expiresInSeconds: number } {
  const claims: Omit<WfcBrowsingClaims, 'iat' | 'exp'> = {
    sub: input.subject,
    sharedFileSystem: input.sharedFileSystem,
    sharedFileSystemNamespace: input.sharedFileSystemNamespace,
    scopes: [...(input.scopes ?? WFC_BROWSING_SCOPES)],
    jti: randomUUID(),
  }
  const token = jwt.sign(claims, config.rpcJwtPrivateKey, {
    algorithm: 'RS256',
    issuer: config.rpcJwtIssuer,
    audience: config.wfcJwtAudience,
    expiresIn: config.wfcTokenTtlSeconds,
  })
  return { token, expiresInSeconds: config.wfcTokenTtlSeconds }
}
