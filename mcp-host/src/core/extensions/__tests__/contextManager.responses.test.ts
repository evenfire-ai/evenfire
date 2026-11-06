/**
 * T-R2 (compaction): the summary call of the context manager reaches the
 * official OpenAI endpoint over Responses. Only `responses.create` is doubled
 * (recorded text responses); the driver, adapter and manager all run.
 */
import { describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../../../llm/openai'
import {
  type RecordedResponse,
  recordedResponse,
} from '../../../llm/openaiFamily/__tests__/responsesFixtures'
import type { WorkspaceService } from '../../../workspace/service'
import { LlmPortAdapter } from '../../adapters/llmPortAdapter'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { estimateTokens } from '../../conversation/compaction'
import type { ChatMessage } from '../../types'
import { PressureContextManager } from '../contextManager'

function conversationOf(turns: number): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: 'user',
      content: `Turn ${i + 1}: ${'a realistic user question with enough words to count '.repeat(6)}`,
    })
    msgs.push({
      role: 'assistant',
      content: `Answer ${i + 1}: ${'a realistic assistant answer spanning a few sentences '.repeat(6)}`,
    })
  }
  return msgs
}

function outputText(raw: RecordedResponse): string {
  const message = raw.output.find(item => item.type === 'message') as {
    content: Array<{ text: string }>
  }
  return message.content.map(part => part.text).join('')
}

async function compactWith(model: string, fixture: string) {
  const create = vi.fn(async (_payload: Record<string, unknown>) => recordedResponse(fixture))
  const chatCreate = vi.fn()
  const provider = new OpenAIProvider(
    { responses: { create }, chat: { completions: { create: chatCreate } } } as never,
    model
  )
  const recordedUsage = vi.fn()
  const port = new LlmPortAdapter(
    provider,
    model,
    'openai',
    undefined,
    undefined,
    undefined,
    undefined,
    recordedUsage
  )
  const workspace = {
    appendDailyLog: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceService
  const msgs = conversationOf(20)
  // The summarize tier: between 85% and 95% of the window.
  const manager = new PressureContextManager(Math.ceil(estimateTokens(msgs) / 0.9), workspace, port)

  const result = await manager.manage(msgs, makeFakeConversation())

  return { create, chatCreate, recordedUsage, workspace, result }
}

describe('T-R2 compaction summarizes over Responses', () => {
  it.each([
    ['gpt-6.1-terra', 'v1-text-gpt-6.1-terra'],
    ['gpt-4.1', 'v1-text-gpt-4.1'],
  ])(
    '%s: the summary is the recorded output text and its usage is recorded',
    async (model, fixture) => {
      const { create, chatCreate, recordedUsage, workspace, result } = await compactWith(
        model,
        fixture
      )

      expect(chatCreate).not.toHaveBeenCalled()
      expect(create).toHaveBeenCalledTimes(1)
      expect(create.mock.calls[0]![0]).toMatchObject({
        model,
        max_output_tokens: 1024,
        store: false,
      })
      const log = vi.mocked(workspace.appendDailyLog).mock.calls[0]![0] as string
      expect(log).toContain(outputText(recordedResponse(fixture)))
      expect(result.filter(m => m.role === 'user')).toHaveLength(5)
      const usage = recordedResponse(fixture).usage as Record<string, number>
      expect(recordedUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        })
      )
    }
  )

  // Chat sent temperature 0.3 to every model, which the reasoning families
  // reject with a 400: compaction was failing for them before this protocol.
  it('omits temperature for a reasoning-family model and keeps it for gpt-4.1', async () => {
    const reasoning = await compactWith('gpt-6.1-terra', 'v1-text-gpt-6.1-terra')
    const plain = await compactWith('gpt-4.1', 'v1-text-gpt-4.1')

    expect(reasoning.create.mock.calls[0]![0]).not.toHaveProperty('temperature')
    expect(plain.create.mock.calls[0]![0]).toHaveProperty('temperature', 0.3)
  })
})
