import { describe, expect, it, vi } from 'vitest'
import type { TrustedEdgeActionContextV2 } from '@clerum/action-context-contracts'
import { RuntimeActionAuthorityError, executeRuntimeEffect } from './actionAuthority'

function context(): TrustedEdgeActionContextV2 {
  return {
    version: 2,
    userId: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    sessionVersion: 3,
    delegationJti: '33333333-3333-4333-8333-333333333333',
    operationId: 'chat.message.invoke',
    resource: {
      environmentId: 'cluster.local/evenfire',
      type: 'host',
      canonicalId: 'host:mcp-host/chatllm',
      logicalId: 'mcp-host/chatllm',
      displayName: 'chatllm',
    },
    target: {
      hostRef: 'mcp-host/chatllm',
      channelType: 'rpc',
      channelId: 'chatllm',
      messageId: '44444444-4444-4444-8444-444444444444',
    },
    targetHash: `ath2_${'a'.repeat(43)}`,
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    behavior: {
      budget: { state: 'known', value: 'direct-budget' },
      credentialPolicy: { state: 'known', value: null },
      approvalPolicy: { state: 'known', value: null },
      filesystemScope: { state: 'known', value: null },
      runtime: { state: 'known', value: 'runtime-a' },
      providerModelPolicy: { state: 'known', value: 'model-policy-a' },
      audit: { state: 'known', value: 'audit-a' },
    },
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

describe('executeRuntimeEffect', () => {
  it.each(['denied', 'unavailable'] as const)(
    'does not contact the provider when current authority is %s',
    async decision => {
      const provider = vi.fn().mockResolvedValue('contacted')
      await expect(
        executeRuntimeEffect({
          context: context(),
          operationId: 'chat.message.invoke',
          checkpoint: vi.fn().mockResolvedValue(decision),
          effect: provider,
        })
      ).rejects.toBeInstanceOf(RuntimeActionAuthorityError)
      expect(provider).not.toHaveBeenCalled()
    }
  )

  it('passes the immutable binding to the checkpoint before the effect', async () => {
    const order: string[] = []
    const result = await executeRuntimeEffect({
      context: context(),
      operationId: 'chat.message.invoke',
      checkpoint: vi.fn().mockImplementation(async binding => {
        order.push('checkpoint')
        expect(binding).toMatchObject({
          version: 2,
          sessionVersion: 3,
          accessPathId: `ap1_${'b'.repeat(43)}`,
          effectiveTeamId: null,
        })
        return 'allowed'
      }),
      effect: vi.fn().mockImplementation(async () => {
        order.push('provider')
        return 'ok'
      }),
    })
    expect(result).toBe('ok')
    expect(order).toEqual(['checkpoint', 'provider'])
  })
})
