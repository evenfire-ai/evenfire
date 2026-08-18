import { controlApiRequest } from '../controlApiClient.js'

export type RpcDelegationV2Response = Readonly<{
  delegationToken: string
  messageId?: string
}>

export async function issueRpcDelegationV2(input: {
  sessionToken: string
  requestBody: unknown
  clientIp?: string
  clientVersion?: string
  accessPathId?: string
  authorizationRevision?: string
}): Promise<RpcDelegationV2Response> {
  return controlApiRequest<RpcDelegationV2Response>('POST', '/external/rpc/delegations', {
    userSessionToken: input.sessionToken,
    body: input.requestBody,
    extraHeaders: {
      ...(input.clientIp ? { 'x-evenfire-client-ip': input.clientIp } : {}),
      ...(input.clientVersion ? { 'x-evenfire-client-version': input.clientVersion } : {}),
      ...(input.accessPathId ? { 'x-evenfire-access-path-id': input.accessPathId } : {}),
      ...(input.authorizationRevision
        ? { 'x-evenfire-authorization-revision': input.authorizationRevision }
        : {}),
    },
  })
}
