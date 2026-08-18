import { describe, expect, it, vi } from 'vitest'
import { knownBehavior, unknownBehavior } from '../src/services/access/accessPath.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

const session = Object.freeze({
  contract: 'v2' as const,
  userId: '10000000-0000-4000-8000-000000000001',
  sid: '20000000-0000-4000-8000-000000000002',
  jti: '30000000-0000-4000-8000-000000000003',
  sessionVersion: 1,
})
const resource = canonicalResourceIdentity({
  environmentId: canonicalEnvironmentId(),
  type: 'host',
  logicalId: 'default/chatllm',
})
const revision = `ar1_${'b'.repeat(43)}`
const selectedPathId = `ap1_${'a'.repeat(43)}`
const known = knownBehavior(null)

function behavior(capabilities: readonly string[], audit = known) {
  return {
    capabilities,
    budget: known,
    credentialPolicy: known,
    approvalPolicy: known,
    filesystemScope: known,
    runtime: known,
    providerModelPolicy: known,
    audit,
  }
}

function path(id: string, capabilities: readonly string[], audit = known) {
  return {
    id,
    kind: 'direct' as const,
    grantId: '40000000-0000-4000-8000-000000000004',
    authorizationRevision: revision,
    behavior: behavior(capabilities, audit),
  }
}

function request(resolve: ReturnType<typeof vi.fn>) {
  return authorizeActionV2(
    {
      session,
      requested: { version: 2, requestedAccessPathId: selectedPathId },
      operationId: 'chat.message.invoke',
      resource,
      operationTarget: {
        hostRef: 'default/chatllm',
        channelType: 'rpc',
        channelId: 'chat-1',
      },
      allocateChatMessageId: true,
    },
    {
      resolve: resolve as never,
      messageId: () => '50000000-0000-4000-8000-000000000005',
    }
  )
}

describe('action authorizer v2', () => {
  it('never treats aggregate effective capabilities as selected-path authority', async () => {
    const selected = path(selectedPathId, ['host.read'])
    const other = path(`ap1_${'c'.repeat(43)}`, ['host.read', 'chat.message.invoke'])
    const resolve = vi.fn().mockResolvedValue({
      status: 'allowed',
      effectiveCapabilities: ['host.read', 'chat.message.invoke'],
      paths: [selected, other],
      selectedPath: selected,
      authorizationRevision: revision,
      validUntil: null,
    })

    await expect(request(resolve)).resolves.toEqual({ status: 'denied', code: 'forbidden' })
  })

  it('allocates the chat message ID before authorization and binds its exact target', async () => {
    const selected = path(selectedPathId, ['chat.message.invoke'])
    const resolve = vi.fn().mockResolvedValue({
      status: 'allowed',
      effectiveCapabilities: ['chat.message.invoke'],
      paths: [selected],
      selectedPath: selected,
      authorizationRevision: revision,
      validUntil: null,
    })

    const result = await request(resolve)
    expect(result.status).toBe('allowed')
    if (result.status !== 'allowed') throw new Error('expected allow')
    expect(result.preparedTarget.messageId).toBe('50000000-0000-4000-8000-000000000005')
    expect(result.context.target).toEqual({
      channelId: 'chat-1',
      channelType: 'rpc',
      hostRef: 'default/chatllm',
      messageId: '50000000-0000-4000-8000-000000000005',
    })
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        operationTarget: result.context.target,
        requestedAccessPathId: selectedPathId,
      }),
      expect.any(Object)
    )
  })

  it('fails unavailable when a registry-required behavior dimension is unknown', async () => {
    const selected = path(selectedPathId, ['chat.message.invoke'], unknownBehavior())
    const resolve = vi.fn().mockResolvedValue({
      status: 'allowed',
      effectiveCapabilities: ['chat.message.invoke'],
      paths: [selected],
      selectedPath: selected,
      authorizationRevision: revision,
      validUntil: null,
    })

    await expect(request(resolve)).resolves.toEqual({
      status: 'authority_unavailable',
      code: 'authority_unavailable',
      retryable: true,
    })
  })
})
