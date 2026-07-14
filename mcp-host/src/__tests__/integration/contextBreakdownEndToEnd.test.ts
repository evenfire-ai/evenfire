/**
 * F1 end-to-end integration: drive the SAME wiring chain `taskExecutor` builds
 * (DefaultReasoningFactory → DefaultReasoningPort → LlmPortAdapter → usage sink
 * → projection → on-demand route) with a deterministic fake provider, and prove
 * that after a turn:
 *   - `conversation.contextBreakdown` carries non-zero buckets, and
 *   - `totalInputTokens` equals the provider's authoritative `input_tokens`
 *     (finalized by the usage sink, NOT the provisional Σbuckets), and
 *   - the `/context-breakdown` route returns that snapshot for the owner and
 *     a 404 (enumeration-defense) for a different sub.
 */
import { describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { ConversationManager } from '../../core/conversation/conversation'
import type { SessionTokenUsage } from '../../core/conversation/conversationStore'
import { DefaultReasoningFactory } from '../../core/reasoning/factory'
import type { SystemPromptParts } from '../../core/reasoning/systemPrompt'
import { OpenAITokenCounter } from '../../core/tokenizer/openaiTokenCounter'
import { FinishReason } from '../../core/types'
import { makeHandlers } from '../../server/__tests__/testHelpers'
import { handleContextBreakdownRoute } from '../../server/routes'
import { projectContextBreakdown } from '../../server/wireProjections'

const PROVIDER_INPUT_TOKENS = 4242

function makeFakeProvider() {
  return {
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(async () => ({
      content: 'final answer',
      tool_calls: null,
      usage: {
        input_tokens: PROVIDER_INPUT_TOKENS,
        output_tokens: 17,
        total_tokens: PROVIDER_INPUT_TOKENS + 17,
      },
      finish_reason: FinishReason.Stop,
    })),
    getProviderType: () => 'openai' as const,
    classifyError: vi.fn(),
  } as any
}

describe('F1 — context breakdown end-to-end (factory → port → sink → projection → route)', () => {
  it('captures buckets at send-time and finalizes the total with the provider usage', async () => {
    const manager = new ConversationManager()
    const conversation = await manager.getOrCreate('user-1')

    const tokenCounter = new OpenAITokenCounter('gpt-4o')
    await tokenCounter.warmup()

    // Wire the adapter's usage sink EXACTLY like taskExecutor:865 + F1.3b.
    const llmPort = new LlmPortAdapter(
      makeFakeProvider(),
      'gpt-4o',
      'openai',
      undefined,
      undefined,
      undefined,
      tokenCounter,
      (usage: SessionTokenUsage) => {
        manager.recordSessionUsage(conversation, usage)
        if (conversation.contextBreakdown && usage.input_tokens > 0) {
          conversation.contextBreakdown.totalInputTokens = usage.input_tokens
        }
      }
    )

    // Wire the factory EXACTLY like taskExecutor:885 + F1.4.
    const factory = new DefaultReasoningFactory(
      llmPort,
      undefined,
      {},
      tokenCounter,
      raw => manager.recordContextBreakdown(conversation, raw),
      100000
    )

    const parts: SystemPromptParts = {
      stable: 'You are a helpful assistant with a stable identity prompt.',
      context: 'Capabilities and meta-context guidance for this session.',
      stableHash: 'h1',
      contextHash: 'h2',
    }
    const reasoning = factory.createWithParts(parts)

    const result = await reasoning.respondWithTools({
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      available_tools: [
        { name: 'web_search', description: 'Search the web', parameters: { type: 'object' } },
      ],
    })

    expect(result.type).toBe('text')

    const breakdown = conversation.contextBreakdown
    expect(breakdown).toBeDefined()
    // All four buckets captured with non-zero counts (tools bucket depends on
    // the #12 fix on Anthropic; OpenAI's tiktoken path always counts them).
    expect(breakdown!.buckets.messages).toBeGreaterThan(0)
    expect(breakdown!.buckets.systemTools).toBeGreaterThan(0)
    expect(breakdown!.buckets.systemPrompt).toBeGreaterThan(0)
    expect(breakdown!.buckets.metaContext).toBeGreaterThan(0)
    // The usage sink overwrote the provisional Σbuckets with the authoritative
    // provider input_tokens from the SAME call (#8) — no lag, exact.
    expect(breakdown!.totalInputTokens).toBe(PROVIDER_INPUT_TOKENS)
    expect(breakdown!.maxTokens).toBe(100000)

    // On-demand projection: fillRatio derived from the authoritative total.
    const wire = projectContextBreakdown(conversation)
    expect(wire!.totalInputTokens).toBe(PROVIDER_INPUT_TOKENS)
    expect(wire!.fillRatio).toBeCloseTo(PROVIDER_INPUT_TOKENS / 100000, 5)
  })

  it('serves the snapshot over GET /context-breakdown for the owner and 404 for another user', async () => {
    const manager = new ConversationManager()
    // Seed a conversation under the rpc session key the route reconstructs.
    const ownerKey = 'user-1:rpc:chatllm:c1'
    const conversation = await manager.getOrCreate(ownerKey, { userId: 'user-1' })
    manager.recordContextBreakdown(conversation, {
      buckets: { messages: 80, systemTools: 25, metaContext: 12, systemPrompt: 6 },
      maxTokens: 100000,
    })

    const handleContextBreakdown = async (userSub: string, agent: string, chatId: string) => {
      const key = `${userSub}:rpc:${agent}:${chatId}`
      const conv = await manager.getSessionByKeyAsync(key)
      if (!conv) return null
      return { breakdown: projectContextBreakdown(conv) ?? null }
    }

    const app = express()
    const inject = (sub: string) => (req: Request, _res: Response, next: NextFunction) => {
      ;(req as unknown as { runtimeCaller: unknown }).runtimeCaller = {
        caller: 'rpc-proxy',
        hostRef: 'chatllm',
        userId: sub,
      }
      next()
    }
    app.get(
      '/owner/sessions/:agent/:chatId/context-breakdown',
      inject('user-1'),
      async (req, res) => {
        await handleContextBreakdownRoute(
          req,
          res,
          makeHandlers({ contextBreakdownHandler: handleContextBreakdown })
        )
      }
    )
    app.get(
      '/other/sessions/:agent/:chatId/context-breakdown',
      inject('user-2'),
      async (req, res) => {
        await handleContextBreakdownRoute(
          req,
          res,
          makeHandlers({ contextBreakdownHandler: handleContextBreakdown })
        )
      }
    )

    const ownerRes = await request(app)
      .get('/owner/sessions/chatllm/c1/context-breakdown')
      .expect(200)
    expect(ownerRes.body.breakdown.buckets).toEqual({
      messages: 80,
      systemTools: 25,
      metaContext: 12,
      systemPrompt: 6,
    })

    // A different sub asking for user-1's session gets the SAME 404 as a missing
    // session — anti-enumeration; the userSub is never taken from the client.
    const otherRes = await request(app)
      .get('/other/sessions/chatllm/c1/context-breakdown')
      .expect(404)
    expect(otherRes.body).toEqual({ error: 'session not found' })
  })
})
