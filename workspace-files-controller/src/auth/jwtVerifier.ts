/**
 * Browsing-JWT verification. Tokens are minted by control-api and signed with
 * the shared RSA keypair (same as session JWTs). wfc only accepts tokens whose:
 *   - iss matches WSF_JWT_ISSUER (default "control-api")
 *   - aud matches WSF_JWT_AUDIENCE ("workspace-files-controller")
 *   - sharedFileSystem claim matches the wfc's WSF_SHARED_FILESYSTEM_NAME
 *   - scopes contain only recognized wfc file-operation permissions
 *   - exp is in the future (jose enforces this)
 *
 * Session JWTs (different aud) are rejected by the audience check.
 */
import { errors as joseErrors, importSPKI, jwtVerify, type JWTPayload } from 'jose'
import { err } from '../errors'

type ImportedKey = Awaited<ReturnType<typeof importSPKI>>

export const WFC_FILE_READ_SCOPE = 'files:read'
export const WFC_FILE_WRITE_SCOPE = 'files:write'
export const WFC_FILE_SCOPES = [WFC_FILE_READ_SCOPE, WFC_FILE_WRITE_SCOPE] as const
export type WfcFileScope = (typeof WFC_FILE_SCOPES)[number]

export interface BrowsingJwtPayload extends JWTPayload {
  sharedFileSystem: string
  sharedFileSystemNamespace: string
  scopes: WfcFileScope[]
}

export interface VerifierConfig {
  publicKeyPem: string
  issuer: string
  audience: string
  /** The SFS this wfc is bound to; the token's `sharedFileSystem` claim must equal this. */
  expectedSharedFileSystem: string
  /** The namespace this wfc is bound to; the token's namespace claim must equal this. */
  expectedSharedFileSystemNamespace: string
}

function normalizeScopes(payload: JWTPayload): WfcFileScope[] {
  const raw = (payload as Partial<BrowsingJwtPayload>).scopes
  if (!Array.isArray(raw) || raw.length === 0) {
    throw err('forbidden', 'token missing required scopes claim')
  }

  const allowed = new Set<string>(WFC_FILE_SCOPES)
  const seen = new Set<string>()
  const scopes: WfcFileScope[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !allowed.has(entry)) {
      throw err('forbidden', 'token contains invalid scope')
    }
    if (seen.has(entry)) {
      throw err('forbidden', 'token contains duplicate scope')
    }
    seen.add(entry)
    scopes.push(entry as WfcFileScope)
  }
  return scopes
}

export function requireWfcFileScope(payload: BrowsingJwtPayload, scope: WfcFileScope): void {
  if (!payload.scopes.includes(scope)) {
    throw err('forbidden', `token missing required ${scope} scope`)
  }
}

export class JwtVerifier {
  private readonly issuer: string
  private readonly audience: string
  private readonly expectedSharedFileSystem: string
  private readonly expectedSharedFileSystemNamespace: string
  private readonly keyPromise: Promise<ImportedKey>

  constructor(config: VerifierConfig) {
    this.issuer = config.issuer
    this.audience = config.audience
    this.expectedSharedFileSystem = config.expectedSharedFileSystem
    this.expectedSharedFileSystemNamespace = config.expectedSharedFileSystemNamespace
    this.keyPromise = importSPKI(config.publicKeyPem, 'RS256')
  }

  /**
   * Verify a Bearer token. Returns the decoded payload on success; throws
   * an HttpError(401|403, ...) on any failure. Audience / SFS-name mismatch
   * is 403 (token is structurally valid but not for this wfc); everything
   * else is 401.
   */
  async verifyBearer(authHeader: string | undefined): Promise<BrowsingJwtPayload> {
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      throw err('unauthorized', 'missing or malformed Authorization header')
    }
    const token = authHeader.slice('bearer '.length).trim()
    if (!token) {
      throw err('unauthorized', 'empty bearer token')
    }

    let payload: JWTPayload
    try {
      const key = await this.keyPromise
      const verified = await jwtVerify(token, key, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
      })
      payload = verified.payload
    } catch (e) {
      if (
        e instanceof joseErrors.JWTExpired ||
        e instanceof joseErrors.JWTInvalid ||
        e instanceof joseErrors.JWSSignatureVerificationFailed ||
        e instanceof joseErrors.JWSInvalid
      ) {
        throw err('unauthorized', `invalid token: ${e.message}`)
      }
      // Audience/issuer mismatch surfaces as JWTClaimValidationFailed;
      // treat that as 403 (token signed by trusted issuer but for someone else).
      if (e instanceof joseErrors.JWTClaimValidationFailed) {
        throw err('forbidden', `token claim validation failed: ${e.message}`)
      }
      throw err('unauthorized', 'token verification failed')
    }

    const sfs = (payload as Partial<BrowsingJwtPayload>).sharedFileSystem
    if (typeof sfs !== 'string' || sfs.length === 0) {
      throw err('forbidden', 'token missing required sharedFileSystem claim')
    }
    if (sfs !== this.expectedSharedFileSystem) {
      throw err(
        'forbidden',
        `token is for sharedFileSystem "${sfs}", but this wfc serves "${this.expectedSharedFileSystem}"`
      )
    }
    const sfsNamespace = (payload as Partial<BrowsingJwtPayload>).sharedFileSystemNamespace
    if (typeof sfsNamespace !== 'string' || sfsNamespace.length === 0) {
      throw err('forbidden', 'token missing required sharedFileSystemNamespace claim')
    }
    if (sfsNamespace !== this.expectedSharedFileSystemNamespace) {
      throw err(
        'forbidden',
        `token is for sharedFileSystem namespace "${sfsNamespace}", but this wfc serves "${this.expectedSharedFileSystemNamespace}"`
      )
    }
    const scopes = normalizeScopes(payload)
    return { ...payload, scopes } as BrowsingJwtPayload
  }
}
