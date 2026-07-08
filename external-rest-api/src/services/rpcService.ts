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

export type RpcAccessTokenResult = IssuedRpcToken | { error: string }

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
      return { error: reason }
    }
    throw error
  }
}
