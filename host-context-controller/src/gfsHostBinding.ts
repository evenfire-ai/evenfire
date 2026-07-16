import { config } from './config'
import { signInternalControlJwt } from './utils/internalControlSigner'

/**
 * HCC 1st-party host gfs token minting (spec community.md §Subjects, plan
 * P3-S02). HCC asks control-api (the sole gfs token minter) for a host token and
 * mounts it on the Host's mcp-host pod.
 *
 * Every HCC-provisioned Host shares the SENTINEL binding `mcp-host/standalone` —
 * the `host.name` (e.g. chatllm) is K8s-provisioning-only (Secret name + labels),
 * NEVER a JWT claim. From control-api's auth perspective every 1st-party host is
 * the same binding class (`host:1st:mcp-host/standalone`). Read-only scope in P3
 * (agent write is P4).
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

const SENTINEL_NAMESPACE = 'mcp-host'
const SENTINEL_NAME = 'standalone'
export const GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS = 10_000
export const GFS_HOST_TOKEN_REQUEST_TIMEOUT_CODE = 'HCC_GFS_HOST_TOKEN_REQUEST_TIMEOUT'

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
export async function mintHostGfsToken(deps: GfsHostBindingDeps = {}): Promise<GfsHostToken> {
  const baseUrl = deps.controlApiBaseUrl ?? config.controlApiBaseUrl
  const sign = deps.signToken ?? signInternalControlJwt
  const doFetch = deps.fetchFn ?? fetch
  const url = `${baseUrl}/api/v1/auth/gfs/${SENTINEL_NAME}/tokens`
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
      body: JSON.stringify({ namespace: SENTINEL_NAMESPACE, scopes: ['gfs.read'] }),
      signal: controller.signal,
    })
    if (controller.signal.aborted) throw timeoutError
    if (!response.ok) {
      throw new Error(`gfs host token mint failed: HTTP ${response.status}`)
    }
    const body = (await response.json()) as GfsHostToken
    if (controller.signal.aborted) throw timeoutError
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
