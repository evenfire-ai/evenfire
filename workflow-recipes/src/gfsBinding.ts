import type { WorkflowRecipeGfsScope } from './types'
import { signInternalControlJwt } from './utils/internalControlSigner'

const CONTROL_API_BASE_URL =
  process.env.CONTROL_API_BASE_URL || 'http://control-api.control-plane.svc.cluster.local:8090'

/**
 * WRC 3rd-party host gfs binding (spec community.md §Subjects, §CRDs
 * (WorkflowRecipe additions); plan P4-S05). WRC registers a recipe's mcp-host as
 * a 3rd-party `host` (subject `host:3rd:<recipeNs>/<recipeName>`) and requests a
 * scoped gfs token from control-api. The recipe's workloads reach gfs THROUGH
 * this host (brokered, gated by allowedCallers) — a workload is never a gfs
 * subject with its own token.
 */

export interface GfsRecipeHostToken {
  token: string
  expiresInSeconds: number
  subject: string
}

export interface GfsBindingDeps {
  controlApiBaseUrl?: string
  /** Signs a WRC InternalControl JWT (iss=wrc). */
  signToken?: () => string
  fetchFn?: typeof fetch
  scopes?: WorkflowRecipeGfsScope[]
}

/**
 * Mint the 3rd-party host gfs token for a recipe's mcp-host. Read-only scope in
 * P4 baseline (publish targets add write where the recipe holds it). Fails loud
 * on any non-2xx — a recipe host without a gfs token must surface.
 */
export async function mintRecipeHostGfsToken(
  recipeNamespace: string,
  recipeName: string,
  deps: GfsBindingDeps = {}
): Promise<GfsRecipeHostToken> {
  const baseUrl = deps.controlApiBaseUrl ?? CONTROL_API_BASE_URL
  const sign = deps.signToken ?? signInternalControlJwt
  const doFetch = deps.fetchFn ?? fetch
  const url = `${baseUrl}/api/v1/auth/gfs/${encodeURIComponent(recipeName)}/tokens`
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${sign()}`,
    },
    body: JSON.stringify({ namespace: recipeNamespace, scopes: deps.scopes ?? ['gfs.read'] }),
  })
  if (!response.ok) {
    throw new Error(`gfs recipe host token mint failed: HTTP ${response.status}`)
  }
  return (await response.json()) as GfsRecipeHostToken
}
