import { describe, expect, it, vi } from 'vitest'
import type { TrustedEdgeActionContextV2 } from '@clerum/action-context-contracts'
import {
  RuntimeActionAuthorityError,
  authorityBindingFromTrustedEdge,
  executeRuntimeEffect,
  withRuntimeActionAuthority,
  withRuntimeActionAuthorityForContextManager,
  withRuntimeActionAuthorityForLlmPort,
} from './actionAuthority'

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

describe('runtime effect adapters', () => {
  it('rechecks before every reasoning attempt and blocks the provider after revocation', async () => {
    const provider = vi.fn().mockResolvedValue({ type: 'text', content: 'contacted' })
    const delegate = {
      respondWithTools: provider,
      continueWithToolResults: provider,
    }
    const checkpoint = vi.fn().mockResolvedValueOnce('allowed').mockResolvedValueOnce('denied')
    const guarded = withRuntimeActionAuthority(
      delegate,
      authorityBindingFromTrustedEdge(context()),
      checkpoint
    )
    const reasoningContext = { messages: [], available_tools: [] }

    await expect(guarded.respondWithTools(reasoningContext)).resolves.toMatchObject({
      type: 'text',
    })
    await expect(guarded.respondWithTools(reasoningContext)).rejects.toMatchObject({
      code: 'access_path_stale',
    })
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('blocks a fallback provider attempt when live authority is unavailable', async () => {
    const complete = vi.fn().mockResolvedValue({ content: 'contacted' })
    const guarded = withRuntimeActionAuthorityForLlmPort(
      {
        complete,
        completeWithTools: vi.fn(),
        modelName: () => 'test-model',
      },
      authorityBindingFromTrustedEdge(context()),
      vi.fn().mockRejectedValue(new Error('checkpoint offline'))
    )

    await expect(guarded.complete({ messages: [] })).rejects.toMatchObject({
      code: 'authority_unavailable',
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('blocks context management and its side effects when live authority is denied', async () => {
    const manage = vi.fn().mockResolvedValue([])
    const guarded = withRuntimeActionAuthorityForContextManager(
      { manage },
      authorityBindingFromTrustedEdge(context()),
      vi.fn().mockResolvedValue('denied')
    )

    await expect(
      guarded.manage([], { pending_approval: undefined } as never)
    ).rejects.toMatchObject({ code: 'access_path_stale' })
    expect(manage).not.toHaveBeenCalled()
  })
})
