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
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${sign()}`,
    },
    body: JSON.stringify({ namespace: SENTINEL_NAMESPACE, scopes: ['gfs.read'] }),
  })
  if (!response.ok) {
    throw new Error(`gfs host token mint failed: HTTP ${response.status}`)
  }
  return (await response.json()) as GfsHostToken
}
