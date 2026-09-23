import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  type ActionAuthorityCheckpointRequestV2,
  canonicalActionTarget,
  hashActionTarget,
} from '@clerum/action-context-contracts'
import type { ActionCheckpointCallerIdentity } from '../src/middleware/actionCheckpointCaller.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  issueHostMessageAdmissionReceipt,
  verifyHostMessageAdmissionReceipt,
} from '../src/utils/auth/hostMessageAdmissionReceipt.js'
import { verifyRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'
import { verifyUserDelegationV2 } from '../src/utils/auth/userDelegationV2Token.js'

const subject = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000002'
const resource = canonicalResourceIdentity({
  environmentId: canonicalEnvironmentId(),
  type: 'host',
  logicalId: 'default/chatllm',
})
const target = canonicalActionTarget({
  hostRef: 'default/chatllm',
  channelType: 'rpc',
  channelId: 'chatllm',
  messageId: '40000000-0000-4000-8000-000000000004',
})
const targetHash = hashActionTarget(target)
const caller: ActionCheckpointCallerIdentity = {
  service: 'rpc-proxy',
  trustPlane: 'internal_service_token',
}

function checkpointRequest(): ActionAuthorityCheckpointRequestV2 {
  return {
    version: 2,
    principal: { sub: subject, sid, sessionVersion: 2 },
    delegationJti: '30000000-0000-4000-8000-000000000003',
    resource,
    operationId: 'chat.message.invoke',
    target,
    targetHash,
    accessPathId: `ap1_${'a'.repeat(43)}`,
    authorizationRevision: `ar1_${'b'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    hostMessageAdmission: {
      sendNonce: 'n'.repeat(43),
      delegationExpiresAt: Math.floor(Date.now() / 1000) + 60,
    },
    domain: { service: 'rpc-proxy', resource, targetHash },
  }
}

describe('Host-message admission receipt producer and verifier', () => {
  it('uses dedicated RS256 type/audience and verifies only the exact checkpoint identity', () => {
    const request = checkpointRequest()
    const context = request.hostMessageAdmission!
    const token = issueHostMessageAdmissionReceipt(request, caller, context)
    const decoded = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
    expect(decoded).toEqual({ alg: 'RS256', typ: 'host-message-admission+jwt' })
    expect(verifyHostMessageAdmissionReceipt(token, request, caller, context)).toBe(true)
    expect(verifyRpcAccessToken(token)).toBeNull()
    expect(verifyUserDelegationV2(token)).toBeNull()

    const altered = [
      {
        ...request,
        principal: { ...request.principal, sub: '10000000-0000-4000-8000-000000000009' },
      },
      {
        ...request,
        principal: { ...request.principal, sid: '20000000-0000-4000-8000-000000000009' },
      },
      { ...request, principal: { ...request.principal, sessionVersion: 3 } },
      { ...request, delegationJti: randomUUID() },
      { ...request, operationId: 'host.status.read' as const },
      {
        ...request,
        resource: canonicalResourceIdentity({
          environmentId: canonicalEnvironmentId(),
          type: 'host',
          logicalId: 'default/other',
        }),
      },
      { ...request, accessPathId: `ap1_${'z'.repeat(43)}` },
      { ...request, authorizationRevision: `ar1_${'z'.repeat(43)}` },
      { ...request, behaviorBindingHash: `bh2_${'z'.repeat(43)}` },
      {
        ...request,
        target: canonicalActionTarget({
          hostRef: 'default/chatllm',
          channelType: 'rpc',
          channelId: 'chatllm',
          messageId: '40000000-0000-4000-8000-000000000009',
        }),
      },
    ]
    for (const candidate of altered) {
      const boundCandidate = { ...candidate, targetHash: hashActionTarget(candidate.target) }
      expect(
        verifyHostMessageAdmissionReceipt(
          token,
          boundCandidate as ActionAuthorityCheckpointRequestV2,
          caller,
          context
        )
      ).toBe(false)
    }
    expect(
      verifyHostMessageAdmissionReceipt(
        token,
        request,
        {
          service: 'mcp-host',
          trustPlane: 'internal_service_token',
        },
        context
      )
    ).toBe(false)
    expect(
      verifyHostMessageAdmissionReceipt(token, request, caller, {
        ...context,
        sendNonce: 'x'.repeat(43),
      })
    ).toBe(false)
    expect(
      verifyHostMessageAdmissionReceipt(token, request, caller, {
        ...context,
        delegationExpiresAt: context.delegationExpiresAt + 1,
      })
    ).toBe(false)
  })

  it('cannot verify at or after delegation expiry', () => {
    const now = Math.floor(Date.now() / 1000)
    const request = checkpointRequest()
    const context = { ...request.hostMessageAdmission!, delegationExpiresAt: now + 5 }
    const token = issueHostMessageAdmissionReceipt(request, caller, context, now)
    expect(verifyHostMessageAdmissionReceipt(token, request, caller, context, now + 4)).toBe(true)
    expect(verifyHostMessageAdmissionReceipt(token, request, caller, context, now + 5)).toBe(false)
  })
})
