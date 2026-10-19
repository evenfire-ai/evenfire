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
  requestedHostRefsInput: unknown,
  clientIp?: string
): Promise<RpcAccessTokenResult> {
  try {
    return await controlApiRequest<IssuedRpcToken>('POST', '/external/rpc/token', {
      body: {
        sessionToken,
        scopes: requestedScopesInput,
        hostRefs: requestedHostRefsInput,
      },
      ...(clientIp ? { extraHeaders: { 'x-evenfire-client-ip': clientIp } } : {}),
    })
  } catch (error) {
    // Preserve the target service's public denial reason while keeping its HTTP contract.
    if (error instanceof ControlApiError && error.status === 403) {
      return { error: error.code ?? 'forbidden' }
    }
    throw error
  }
}
