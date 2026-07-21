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
 * subject with its own token. The returned subject must match that exact recipe
 * identity; a different subject is rejected even on a successful HTTP response.
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

interface UntrustedGfsTokenClaims {
  sub?: unknown
  scopes?: unknown
}

function decodeUntrustedJwtPayload(token: string): UntrustedGfsTokenClaims {
  const segments = token.split('.')
  const payload = segments[1]
  if (
    segments.length !== 3 ||
    segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment)) ||
    payload.length % 4 === 1
  ) {
    throw new Error('gfs recipe host token is not a well-formed JWT')
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('payload is not an object')
    }
    return decoded as UntrustedGfsTokenClaims
  } catch {
    throw new Error('gfs recipe host token has a malformed JWT payload')
  }
}

function validateUntrustedTokenClaims(
  token: unknown,
  expectedSubject: string,
  expectedScopes: WorkflowRecipeGfsScope[]
): asserts token is string {
  if (typeof token !== 'string') {
    throw new Error('gfs recipe host token is not a well-formed JWT')
  }

  // This is deliberately metadata validation only. The gfs service remains the
  // authority that verifies the token signature when the credential is used.
  const claims = decodeUntrustedJwtPayload(token)
  if (claims.sub !== expectedSubject) {
    throw new Error(
      `gfs recipe host token claim subject mismatch: expected ${expectedSubject}, received ${String(claims.sub)}`
    )
  }
  if (
    !Array.isArray(claims.scopes) ||
    claims.scopes.length !== expectedScopes.length ||
    claims.scopes.some((scope, index) => scope !== expectedScopes[index])
  ) {
    throw new Error('gfs recipe host token claim scopes do not exactly match requested scopes')
  }
}

/**
 * Mint the 3rd-party host gfs token for a recipe's mcp-host. The caller derives
 * the read/write ceiling from the recipe intent, while resource grants remain
 * authoritative. Fails loud on any non-2xx or mismatched issued authority.
 */
export async function mintRecipeHostGfsToken(
  recipeNamespace: string,
  recipeName: string,
  deps: GfsBindingDeps = {}
): Promise<GfsRecipeHostToken> {
  const expectedSubject = `host:3rd:${recipeNamespace}/${recipeName}`
  const expectedScopes: WorkflowRecipeGfsScope[] = [...(deps.scopes ?? ['gfs.read'])]
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
    body: JSON.stringify({ namespace: recipeNamespace, scopes: expectedScopes }),
  })
  if (!response.ok) {
    throw new Error(`gfs recipe host token mint failed: HTTP ${response.status}`)
  }
  const binding = (await response.json()) as GfsRecipeHostToken
  if (binding.subject !== expectedSubject) {
    throw new Error(
      `gfs recipe host token subject mismatch: expected ${expectedSubject}, received ${binding.subject}`
    )
  }
  validateUntrustedTokenClaims(binding.token, expectedSubject, expectedScopes)
  return binding
}
