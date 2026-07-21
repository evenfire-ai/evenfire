import { config } from './config'
import { signInternalControlJwt } from './utils/internalControlSigner'

/**
 * HCC 1st-party host gfs token minting (spec community.md §Subjects, plan
 * P3-S02). HCC asks control-api (the sole gfs token minter) for a host token and
 * mounts it on the Host's mcp-host pod.
 *
 * Each HCC-provisioned Host keeps its Kubernetes identity in the GFS subject.
 * For example, the `mcp-host/chatllm` Host receives
 * `host:1st:mcp-host/chatllm`; another Host is never authorized through the
 * same binding. The token ceiling permits the Control UI's supported Host
 * operations, read and write; resource grants still decide which concrete
 * resources the Host may access.
 */

export interface GfsHostToken {
  token: string
  expiresInSeconds: number
  subject: string
}

/** Dependencies, injectable so the mint is unit-tested without a live control-api. */
export interface GfsHostBindingDeps {
  controlApiBaseUrl?: string
  /** Signs an HCC InternalControl JWT (iss=hcc). */
  signToken?: () => string
  fetchFn?: typeof fetch
}

export interface GfsFirstPartyHostRef {
  name: string
  namespace: string
}

export const GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS = 10_000
export const GFS_HOST_TOKEN_REQUEST_TIMEOUT_CODE = 'HCC_GFS_HOST_TOKEN_REQUEST_TIMEOUT'
const GFS_HOST_TOKEN_SCOPES = ['gfs.read', 'gfs.write'] as const

function validateIssuedTokenClaims(
  token: unknown,
  expectedSubject: string
): asserts token is string {
  if (typeof token !== 'string') {
    throw new Error('gfs host token is not a JWT')
  }

  const segments = token.split('.')
  if (segments.length !== 3 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new Error('gfs host token is not a JWT')
  }

  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('gfs host token has a malformed JWT payload')
  }

  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw new Error('gfs host token has a malformed JWT payload')
  }

  const payload = claims as Record<string, unknown>
  if (payload.sub !== expectedSubject) {
    throw new Error(
      `gfs host token claim subject mismatch: expected ${expectedSubject}, received ${String(payload.sub)}`
    )
  }

  const scopes = payload.scopes
  if (
    !Array.isArray(scopes) ||
    scopes.length !== GFS_HOST_TOKEN_SCOPES.length ||
    !GFS_HOST_TOKEN_SCOPES.every((scope, index) => scopes[index] === scope)
  ) {
    throw new Error(
      `gfs host token claim scopes mismatch: expected ${JSON.stringify(GFS_HOST_TOKEN_SCOPES)}`
    )
  }
}

export class GfsHostTokenMintTimeoutError extends Error {
  readonly code = GFS_HOST_TOKEN_REQUEST_TIMEOUT_CODE

  constructor(
    readonly timeoutMs: number,
    options?: { cause?: unknown }
  ) {
    super(
      `gfs host token mint exceeded its ${timeoutMs}ms deadline`,
      options?.cause === undefined ? undefined : { cause: options.cause }
    )
    this.name = 'GfsHostTokenMintTimeoutError'
  }
}

/**
 * Mint a 1st-party host gfs token via control-api's provisioner route. Fails
 * loud on any non-2xx — a host without a working gfs token must surface, never
 * silently degrade.
 */
export async function mintHostGfsToken(
  host: GfsFirstPartyHostRef,
  deps: GfsHostBindingDeps = {}
): Promise<GfsHostToken> {
  const baseUrl = deps.controlApiBaseUrl ?? config.controlApiBaseUrl
  const sign = deps.signToken ?? signInternalControlJwt
  const doFetch = deps.fetchFn ?? fetch
  const url = `${baseUrl}/api/v1/auth/gfs/${encodeURIComponent(host.name)}/tokens`
  const expectedSubject = `host:1st:${host.namespace}/${host.name}`
  const timeoutError = new GfsHostTokenMintTimeoutError(GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(timeoutError), GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS)
  timer.unref?.()

  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${sign()}`,
      },
      body: JSON.stringify({
        namespace: host.namespace,
        scopes: GFS_HOST_TOKEN_SCOPES,
      }),
      signal: controller.signal,
    })
    if (controller.signal.aborted) throw timeoutError
    if (!response.ok) {
      throw new Error(`gfs host token mint failed: HTTP ${response.status}`)
    }
    const body = (await response.json()) as GfsHostToken
    if (controller.signal.aborted) throw timeoutError
    if (body.subject !== expectedSubject) {
      throw new Error(
        `gfs host token subject mismatch: expected ${expectedSubject}, received ${body.subject}`
      )
    }
    validateIssuedTokenClaims(body.token, expectedSubject)
    return body
  } catch (error) {
    if (error instanceof GfsHostTokenMintTimeoutError) throw error
    if (controller.signal.aborted) {
      throw new GfsHostTokenMintTimeoutError(GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS, {
        cause: error,
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
