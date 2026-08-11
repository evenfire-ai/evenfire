import { controlApiRequest } from '../controlApiClient.js'
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

export async function issueRpcAccessToken(
  sessionToken: string,
  requestedScopesInput: unknown,
  requestedHostRefsInput: unknown
): Promise<IssuedRpcToken> {
  return controlApiRequest<IssuedRpcToken>('POST', '/external/rpc/token', {
    body: {
      sessionToken,
      scopes: requestedScopesInput,
      hostRefs: requestedHostRefsInput,
    },
  })
}
