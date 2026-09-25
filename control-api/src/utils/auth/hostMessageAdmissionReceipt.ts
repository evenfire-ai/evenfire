import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { canonicalActionTargetJson } from '@clerum/action-context-contracts'
import type {
  ActionAuthorityCheckpointRequestV2,
  CanonicalActionTarget,
  HostMessageAdmissionCheckpointContext,
} from '@clerum/action-context-contracts'
import { config } from '../../config.js'
import type { ActionCheckpointCallerIdentity } from '../../middleware/actionCheckpointCaller.js'

export const HOST_MESSAGE_ADMISSION_RECEIPT_AUDIENCE =
  'evenfire-host-message-admission-recheck' as const
export const HOST_MESSAGE_ADMISSION_RECEIPT_TYPE = 'host_message_admission_receipt' as const
export const HOST_MESSAGE_ADMISSION_RECEIPT_HEADER_TYPE = 'host-message-admission+jwt' as const
const RECEIPT_MAX_TTL_SECONDS = 300

const ALLOWED_CLAIMS = new Set([
  'typ',
  'ver',
  'sub',
  'sid',
  'sv',
  'delegationJti',
  'operationId',
  'resource',
  'target',
  'targetHash',
  'accessPathId',
  'authorizationRevision',
  'behaviorBindingHash',
  'checkpointCaller',
  'checkpointTrustPlane',
  'sendNonce',
  'delegationExpiresAt',
  'jti',
  'iat',
  'exp',
  'iss',
  'aud',
])

function receiptClaims(
  request: ActionAuthorityCheckpointRequestV2,
  caller: ActionCheckpointCallerIdentity,
  context: HostMessageAdmissionCheckpointContext
) {
  return {
    typ: HOST_MESSAGE_ADMISSION_RECEIPT_TYPE,
    ver: 1,
    sub: request.principal.sub,
    sid: request.principal.sid,
    sv: request.principal.sessionVersion,
    delegationJti: request.delegationJti,
    operationId: request.operationId,
    resource: request.resource,
    target: request.target,
    targetHash: request.targetHash,
    accessPathId: request.accessPathId,
    authorizationRevision: request.authorizationRevision,
    behaviorBindingHash: request.behaviorBindingHash,
    checkpointCaller: caller.service,
    checkpointTrustPlane: caller.trustPlane,
    sendNonce: context.sendNonce,
    delegationExpiresAt: context.delegationExpiresAt,
  }
}

export function issueHostMessageAdmissionReceipt(
  request: ActionAuthorityCheckpointRequestV2,
  caller: ActionCheckpointCallerIdentity,
  context: HostMessageAdmissionCheckpointContext,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  if (
    request.operationId !== 'chat.message.invoke' ||
    caller.service !== 'rpc-proxy' ||
    caller.trustPlane !== 'internal_service_token' ||
    context.delegationExpiresAt <= nowSeconds
  ) {
    throw new Error('host_message_admission_receipt_invalid_binding')
  }
  const exp = Math.min(nowSeconds + RECEIPT_MAX_TTL_SECONDS, context.delegationExpiresAt)
  return jwt.sign(
    {
      ...receiptClaims(request, caller, context),
      jti: randomUUID(),
      iat: nowSeconds,
      exp,
    },
    config.rpcJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.rpcJwtIssuer,
      audience: HOST_MESSAGE_ADMISSION_RECEIPT_AUDIENCE,
      header: { alg: 'RS256', typ: HOST_MESSAGE_ADMISSION_RECEIPT_HEADER_TYPE },
    }
  )
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function verifyHostMessageAdmissionReceipt(
  token: string,
  request: ActionAuthorityCheckpointRequestV2,
  caller: ActionCheckpointCallerIdentity,
  context: HostMessageAdmissionCheckpointContext,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true })
    if (
      !decoded ||
      decoded.header.alg !== 'RS256' ||
      decoded.header.typ !== HOST_MESSAGE_ADMISSION_RECEIPT_HEADER_TYPE
    ) {
      return false
    }
    const payload = jwt.verify(token, config.rpcJwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.rpcJwtIssuer,
      audience: HOST_MESSAGE_ADMISSION_RECEIPT_AUDIENCE,
      clockTimestamp: nowSeconds,
    }) as jwt.JwtPayload
    if (
      Object.keys(payload).some(key => !ALLOWED_CLAIMS.has(key)) ||
      payload.typ !== HOST_MESSAGE_ADMISSION_RECEIPT_TYPE ||
      payload.ver !== 1 ||
      payload.iss !== config.rpcJwtIssuer ||
      payload.aud !== HOST_MESSAGE_ADMISSION_RECEIPT_AUDIENCE ||
      typeof payload.jti !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        payload.jti
      ) ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > nowSeconds ||
      payload.exp <= payload.iat ||
      payload.exp <= nowSeconds ||
      payload.exp > context.delegationExpiresAt ||
      payload.exp - payload.iat > RECEIPT_MAX_TTL_SECONDS ||
      request.operationId !== 'chat.message.invoke' ||
      caller.service !== 'rpc-proxy' ||
      caller.trustPlane !== 'internal_service_token'
    ) {
      return false
    }
    const expected = receiptClaims(request, caller, context)
    return Object.entries(expected).every(([key, value]) => {
      const actual = payload[key]
      return key === 'resource'
        ? canonicalJson(actual) === canonicalJson(value)
        : key === 'target'
          ? canonicalActionTargetJson(actual as CanonicalActionTarget) ===
            canonicalActionTargetJson(value as CanonicalActionTarget)
          : actual === value
    })
  } catch {
    return false
  }
}
