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
          Array.isArray(revokedHostRefs) &&
          revokedHostRefs.length > 0 &&
          revokedHostRefs.every(
            (hostRef): hostRef is string => typeof hostRef === 'string' && hostRef.length > 0
          )
        ) {
          return { error: reason, code: RPC_TOKEN_REVOKED_CODE, revokedHostRefs }
        }
      }
      return { error: reason }
    }
    throw error
  }
}
