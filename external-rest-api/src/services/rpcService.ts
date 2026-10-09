import { ControlApiError, controlApiRequest } from '../controlApiClient.js'
import { RpcAccessScope, RpcScope } from '../types.js'

type IssuedRpcToken = {
  token: string
  accessScope: RpcAccessScope
  teamId: string | null
  scopes: RpcScope[]
  hostRefs: string[]
  expiresInSeconds: number
  droppedScopes?: RpcScope[]
}

export const RPC_TOKEN_REVOKED_CODE = 'host_access_revoked'

export type RpcAccessTokenDenial = {
  error: string
  code?: typeof RPC_TOKEN_REVOKED_CODE
  revokedHostRefs?: string[]
}

export type RpcAccessTokenResult = IssuedRpcToken | RpcAccessTokenDenial

/** Accept only the exact list the mint can emit for this request. Never repair a malformed denial. */
function isCanonicalMintRevocationList(
  candidate: unknown,
  requestedHostRefsInput: unknown
): candidate is string[] {
  if (!Array.isArray(candidate) || !Array.isArray(requestedHostRefsInput)) return false

  const requestedRefs = new Set<string>()
  for (const value of requestedHostRefsInput) {
    if (typeof value !== 'string') return false
    const ref = value.trim()
    if (!ref || ref === '*') return false
    requestedRefs.add(ref)
  }
  if (requestedRefs.size === 0 || candidate.length !== requestedRefs.size) return false

  const canonicalRefs = Array.from(requestedRefs).sort()
  return candidate.every((ref, index) => ref === canonicalRefs[index])
}

export async function issueRpcAccessToken(
  sessionToken: string,
  requestedScopesInput: unknown,
  requestedHostRefsInput: unknown
): Promise<RpcAccessTokenResult> {
  try {
    return await controlApiRequest<IssuedRpcToken>('POST', '/external/rpc/token', {
      body: {
        sessionToken,
        scopes: requestedScopesInput,
        hostRefs: requestedHostRefsInput,
      },
    })
  } catch (error) {
    // Relay control-api's specific denial reason (e.g. `desktop_requires_team`)
    // instead of collapsing every 403 to a generic message. The desktop app and
    // logs can then distinguish "needs a team" from a genuine auth failure.
    if (error instanceof ControlApiError && error.status === 403) {
      const reason =
        error.body && typeof error.body === 'object' && 'error' in error.body
          ? String((error.body as { error: unknown }).error)
          : 'forbidden'
      if (error.body && typeof error.body === 'object') {
        const body = error.body as Record<string, unknown>
        const revokedHostRefs = body.revokedHostRefs
        if (
          body.code === RPC_TOKEN_REVOKED_CODE &&
          isCanonicalMintRevocationList(revokedHostRefs, requestedHostRefsInput)
        ) {
          return { error: reason, code: RPC_TOKEN_REVOKED_CODE, revokedHostRefs }
        }
      }
      return { error: reason }
    }
    throw error
  }
}
