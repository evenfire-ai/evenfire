/**
 * LM1 — the `loopInjected` marker is internal to the host. The LLM drivers map
 * message fields explicitly, so a marked message reaches the provider as a
 * plain user message and the marker never appears in a request body.
 *
 * Each case sends a real marked message through the driver and inspects the
 * body the driver hands to its client. The injected text is the liveness
 * witness: it must be present in the body, so the test fails if the message
 * was dropped instead of projected.
 */
import { describe, expect, it, vi } from 'vitest'
import { ClaudeProvider } from '../../../llm/claude'
import { CodexSubscriptionProvider } from '../../../llm/codexSubscription'
import { GrokSubscriptionProvider } from '../../../llm/grokSubscription'
import { OpenAIProvider } from '../../../llm/openai'
import type { ChatMessage } from '../../types'
import { isLoopInjectedMessage, loopInjectedUserMessage } from '../toolUseLoopMessages'

const MARKER_FIELD = 'loopInjected'
const GENUINE_TEXT = 'Summarize the attached file.'
const ASSISTANT_TEXT = 'Answering before reading the rest.'
const INJECTED_TEXT =
  'The previous assistant turn was empty. Continue the user request now. Use the available tools when needed, and do not invent workflow names, workflow results, approvals, runs, or artifacts.'
const TOOLS = [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }]

function conversation(): ChatMessage[] {
  const injected = loopInjectedUserMessage(INJECTED_TEXT)
  // Precondition: the input really carries the marker the drivers must drop.
  expect(isLoopInjectedMessage(injected)).toBe(true)
  return [
    { role: 'user', content: GENUINE_TEXT },
    { role: 'assistant', content: ASSISTANT_TEXT },
    injected,
  ]
}

function expectNoMarker(body: unknown): void {
  const serialized = JSON.stringify(body)
  // Witness: the injected message was projected into this body.
  expect(serialized).toContain(INJECTED_TEXT)
  expect(serialized).toContain(GENUINE_TEXT)
  expect(serialized).not.toContain(MARKER_FIELD)
}

describe('LM1 the loopInjected marker never reaches a provider request body', () => {
  it('OpenAI chat completions', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    const provider = new OpenAIProvider({ chat: { completions: { create } } } as never, 'gpt-4o')

    await provider.completeSingleTurnWithTools(conversation(), TOOLS)

    expect(create).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0]![0] as { messages: unknown[] }
    expect(body.messages).toEqual([
      { role: 'user', content: GENUINE_TEXT },
      { role: 'assistant', content: ASSISTANT_TEXT },
      { role: 'user', content: INJECTED_TEXT },
    ])
    expectNoMarker(body)
  })

  it('Codex subscription authorize request and proxy stream request', async () => {
    const authorize = vi.fn().mockResolvedValue({
      providerAttemptId: 'attempt-1',
      requestHash: 'a'.repeat(64),
      executionTicket: 'ticket-123456',
      expiresAt: '2026-08-20T10:00:00.000Z',
    })
    const stream = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [], outcome: 'success' })
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', {
      authorizer: { authorize },
      proxy: { stream },
      attemptContext: () => ({ policyRevision: 1, policyHash: 'b'.repeat(64), hostRef: 'chatllm' }),
    } as never)

    await provider.completeSingleTurnWithTools(conversation(), TOOLS)

    expect(authorize).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(1)
    const authorized = authorize.mock.calls[0]![0] as { request: { messages: unknown[] } }
    expect(authorized.request.messages).toEqual([
      { role: 'user', content: GENUINE_TEXT },
      { role: 'assistant', content: ASSISTANT_TEXT },
      { role: 'user', content: INJECTED_TEXT },
    ])
    expectNoMarker(authorized)
    const { signal: _signal, ...streamed } = stream.mock.calls[0]![0] as Record<string, unknown>
    expectNoMarker(streamed)
  })

  it('Grok subscription authorize request and proxy stream request', async () => {
    const authorize = vi.fn().mockResolvedValue({
      providerAttemptId: 'attempt-1',
      requestHash: 'a'.repeat(64),
      executionTicket: 'ticket-123456',
      expiresAt: '2026-08-20T10:00:00.000Z',
    })
    const stream = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [], outcome: 'success' })
    const provider = new GrokSubscriptionProvider('grok-4.6', {
      authorizer: { authorize },
      proxy: { stream },
      attemptContext: () => ({ policyRevision: 1, policyHash: 'b'.repeat(64), hostRef: 'chatllm' }),
    } as never)

    await provider.completeSingleTurnWithTools(conversation(), TOOLS)

    expect(authorize).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(1)
    const authorized = authorize.mock.calls[0]![0] as { request: { messages: unknown[] } }
    expect(authorized.request.messages).toEqual([
      { role: 'user', content: GENUINE_TEXT },
      { role: 'assistant', content: ASSISTANT_TEXT },
      { role: 'user', content: INJECTED_TEXT },
    ])
    expectNoMarker(authorized)
    const { signal: _signal, ...streamed } = stream.mock.calls[0]![0] as Record<string, unknown>
    expectNoMarker(streamed)
  })

  it('Claude messages', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const provider = new ClaudeProvider({ messages: { create } } as never, 'claude-sonnet-4-6')

    await provider.completeSingleTurnWithTools(conversation(), TOOLS)

    expect(create).toHaveBeenCalledTimes(1)
    expectNoMarker(create.mock.calls[0]![0])
  })
})
