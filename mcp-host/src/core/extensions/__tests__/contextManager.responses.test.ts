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
import { PressureContextManager, type PressureContextManagerOptions } from '../contextManager'

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

function fakeWorkspace(): WorkspaceService {
  return {
    appendDailyLog: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceService
}

/** The summarize tier: between 85% and 95% of the window. */
function summarizeTierWindow(msgs: ChatMessage[]): number {
  return Math.ceil(estimateTokens(msgs) / 0.9)
}

async function compactWith(
  model: string,
  fixture: string | (() => RecordedResponse),
  options: PressureContextManagerOptions = {}
) {
  const respond = typeof fixture === 'string' ? () => recordedResponse(fixture) : fixture
  const create = vi.fn(async (_payload: Record<string, unknown>) => respond())
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
  const workspace = fakeWorkspace()
  const msgs = conversationOf(20)
  const manager = new PressureContextManager(
    summarizeTierWindow(msgs),
    workspace,
    port,
    undefined,
    options
  )

  const result = await manager.manage(msgs, makeFakeConversation())

  return { create, chatCreate, recordedUsage, workspace, result, manager }
}

/**
 * What MoveToWorkspace produces for the same conversation, taken from the real
 * manager: without an LLM port the summarize tier archives the turns verbatim.
 */
async function archivedVerbatim() {
  const workspace = fakeWorkspace()
  const msgs = conversationOf(20)
  const manager = new PressureContextManager(summarizeTierWindow(msgs), workspace)
  const result = await manager.manage(msgs, makeFakeConversation())
  const logs = vi.mocked(workspace.appendDailyLog).mock.calls.map(call => call[0] as string)
  return { result, logs }
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

/** The recorded empty `completed` message with its text replaced by whitespace. */
function whitespaceOnlyMessage(): RecordedResponse {
  const raw = recordedResponse('v2-final-answer-empty-message-gpt-6.1-terra')
  const message = raw.output.find(item => item.type === 'message') as {
    content: Array<{ text: string }>
  }
  for (const part of message.content) part.text = '  \n\t \n'
  return raw
}

// A reasoning model can spend the whole output budget thinking: the call
// succeeds with an empty or cut-off body. Persisting it would replace the
// archived turns with nothing, so the turns are archived verbatim instead.
describe('T-R2 compaction falls back to MoveToWorkspace on an unusable summary', () => {
  it.each([
    // T-R2b: reasoning only, no message item.
    ['gpt-6.1-terra', 'v1-incomplete-gpt-6.1-terra', undefined],
    // T-R2c: partial output text cut by max_output_tokens.
    ['gpt-5.4-mini', 'v1-incomplete-gpt-5.4-mini', undefined],
    // A `completed` response whose message is empty: the finish reason is not
    // Length, so only the empty-body check keeps it from being persisted.
    ['gpt-6.1-terra', 'v2-final-answer-empty-message-gpt-6.1-terra', undefined],
    // The same `completed` response whose message is only whitespace: still
    // nothing to persist as a summary.
    ['gpt-6.1-terra', 'whitespace-only message', whitespaceOnlyMessage],
  ])('%s (%s): the archived turns reach the daily log in full', async (model, label, fixture) => {
    const { create, workspace, result } = await compactWith(model, fixture ?? label)
    const expected = await archivedVerbatim()

    expect(create).toHaveBeenCalledTimes(1)
    const logs = vi.mocked(workspace.appendDailyLog).mock.calls.map(call => call[0] as string)
    expect(logs).toEqual(expected.logs)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^### Context Compacted \(\d+ turns archived\)/)
    expect(logs[0]).toContain('Turn 1:')
    expect(logs[0]).toContain('Answer 1:')
    expect(logs.join('')).not.toContain('### Context Summary')
    expect(result).toEqual(expected.result)
  })

  it('gpt-5.4-mini: the truncated text is not persisted', async () => {
    const { workspace } = await compactWith('gpt-5.4-mini', 'v1-incomplete-gpt-5.4-mini')
    const truncated = outputText(recordedResponse('v1-incomplete-gpt-5.4-mini'))

    expect(truncated.length).toBeGreaterThan(0)
    const logs = vi.mocked(workspace.appendDailyLog).mock.calls.map(call => call[0] as string)
    expect(logs.join('')).not.toContain(truncated)
  })

  it('structured mode: a completed summary becomes the previous summary', async () => {
    const { manager } = await compactWith('gpt-6.1-terra', 'v1-text-gpt-6.1-terra', {
      structuredSummaryEnabled: true,
    })

    expect(manager.getPreviousSummary()).toBeTruthy()
  })

  it('structured mode: an empty summary does not become the previous summary', async () => {
    const { manager, workspace } = await compactWith(
      'gpt-6.1-terra',
      'v1-incomplete-gpt-6.1-terra',
      { structuredSummaryEnabled: true }
    )

    expect(manager.getPreviousSummary()).toBeNull()
    const logs = vi.mocked(workspace.appendDailyLog).mock.calls.map(call => call[0] as string)
    expect(logs.join('')).not.toContain('### Context Summary')
  })
})
