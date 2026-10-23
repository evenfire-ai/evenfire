import { controlApiRequest } from '../controlApiClient.js'

export type RpcDelegationV2Response = Readonly<{
  delegationToken: string
  messageId?: string
}>

const MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COMPACT_JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseRpcDelegationResponse(value: unknown, requestBody: unknown): RpcDelegationV2Response {
  if (
    !isRecord(value) ||
    Object.keys(value).some(key => !['delegationToken', 'messageId'].includes(key))
  ) {
    throw new Error('invalid_rpc_delegation_response')
  }
  const token = value.delegationToken
  const segments = typeof token === 'string' ? token.split('.') : []
  if (
    typeof token !== 'string' ||
    !token.trim() ||
    segments.length !== 3 ||
    segments.some(segment => !COMPACT_JWT_SEGMENT_PATTERN.test(segment))
  ) {
    throw new Error('invalid_rpc_delegation_response')
  }

  const operationId = isRecord(requestBody) ? requestBody.operationId : undefined
  const messageId = value.messageId
  if (
    (operationId === 'chat.message.invoke' &&
      (typeof messageId !== 'string' || !MESSAGE_ID_PATTERN.test(messageId))) ||
    (operationId !== 'chat.message.invoke' && messageId !== undefined)
  ) {
    throw new Error('invalid_rpc_delegation_response')
  }

  return Object.freeze({
    delegationToken: token,
    ...(typeof messageId === 'string' ? { messageId } : {}),
  })
}

export async function issueRpcDelegationV2(input: {
  sessionToken: string
  requestBody: unknown
  clientIp?: string
  clientVersion?: string
  accessPathId?: string
  authorizationRevision?: string
}): Promise<RpcDelegationV2Response> {
  const response = await controlApiRequest<unknown>('POST', '/external/rpc/delegations', {
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
  return parseRpcDelegationResponse(response, input.requestBody)
}
