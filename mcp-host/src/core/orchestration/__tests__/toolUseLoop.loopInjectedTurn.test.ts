/**
 * LM1 — user messages the loop injects itself (recovery prompts, nudges) do not
 * start a new turn for the C17 attachment page collapse.
 *
 * The loop runs for real: a page is read, the loop injects a `role: 'user'`
 * message, a second page is read, and the context manager applies `prePrune`
 * under qualifying pressure on every iteration. Both pages belong to the same
 * user turn, so neither may be collapsed before the model answers.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { LlmError, LlmErrorCode } from '../../errors'
import { NudgeController } from '../../extensions/nudgeController'
import {
  DEFAULT_PRE_PRUNE_OPTIONS,
  type PrePrunePressure,
  prePrune,
} from '../../extensions/prePrune'
import type { LoopController, ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { ChatMessage, ReasoningContext, RespondResult, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { DefaultLoopController, buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'

const READ_TOOL = 'clerum__attachment_read'
const PAGE_LENGTH = 4096
const FIRST_PAGE_TEXT = 'first page body '.repeat(256)
const SECOND_PAGE_TEXT = 'second page body '.repeat(241)
const PRESSURE_ON: PrePrunePressure = { inputTokens: 900, contextWindowTokens: 1000 }
const COLLAPSE_MARKER =
  '[earlier attachment page collapsed; reattach the file in a new message to re-read it, and resume reading at nextOffset]'
const RECOVERY_PROMPT =
  'The previous assistant turn after the tool result was empty. Reply to the user using only the tool results above. Do not infer results that were not returned.'
const NUDGE_PROMPT =
  'You have tools available. Please use the appropriate tool(s) to answer the question rather than responding from memory alone. Check the available tools and try again.'

function nativePage(offset: number): string {
  return JSON.stringify({
    attachmentId: 'att_1',
    referenceId: 'ref_sha256 deadbeef',
    kind: 'text',
    byteRange: { offset, length: PAGE_LENGTH },
    truncated: true,
    nextOffset: offset + PAGE_LENGTH,
    text: offset === 0 ? FIRST_PAGE_TEXT : SECOND_PAGE_TEXT,
  })
}

function makeReadTool(): Tool {
  return {
    name: () => READ_TOOL,
    description: () => 'Read a page of an attached file',
    parametersSchema: () => ({ type: 'object', properties: { offset: { type: 'number' } } }),
    execute: vi.fn(
      async (params: Record<string, unknown>): Promise<ToolOutput> => ({
        content: nativePage(typeof params.offset === 'number' ? params.offset : 0),
        duration_ms: 1,
        is_error: false,
      })
    ),
    requiresSanitization: () => false,
    requiresApproval: () => false,
  }
}

function makeRegistry(tool: Tool): ToolRegistry {
  return {
    get: (name: string) => (name === tool.name() ? tool : null),
    listDefinitions: () => [
      { name: tool.name(), description: tool.description(), parameters: tool.parametersSchema() },
    ],
    register: vi.fn(),
  }
}

/** Page payload of a tool message, with or without the `<tool_output>` wrapper. */
function pageText(message: ChatMessage): string {
  const inner = /^<tool_output [^>]*>\n([\s\S]*)\n<\/tool_output>$/.exec(message.content)
  return (JSON.parse(inner ? inner[1]! : message.content) as { text: string }).text
}

function readCall(id: string, offset: number): RespondResult {
  return {
    type: 'tool_calls',
    calls: [{ id, name: READ_TOOL, arguments: { attachmentId: 'att_1', offset } }],
  }
}

interface Scenario {
  injected: string
  /** Model response between the two reads that makes the loop inject a user message. */
  between: RespondResult
  loopController?: Partial<LoopController>
}

function recoveryScenario(): Scenario {
  return {
    injected: RECOVERY_PROMPT,
    between: {
      type: 'error',
      error: new LlmError(
        'LLM produced empty response (no text, no tool calls)',
        'glm-4.7',
        LlmErrorCode.InvalidResponse,
        false
      ),
    },
  }
}

function nudgeScenario(): Scenario {
  // The real NudgeController produces the nudge; the first text is rejected so
  // the loop pushes that nudge through its own `onTextRejected` site.
  const nudger = new NudgeController(new DefaultLoopController())
  let rejectedOnce = false
  return {
    injected: NUDGE_PROMPT,
    between: { type: 'text', content: 'Answering before reading the rest.' },
    loopController: {
      shouldAccept: () => {
        if (rejectedOnce) return true
        rejectedOnce = true
        return false
      },
      onTextRejected: (content, iteration) => nudger.onTextRejected(content, iteration),
    },
  }
}

async function runScenario(scenario: Scenario) {
  const results: RespondResult[] = [
    readCall('tc_p1', 0),
    scenario.between,
    readCall('tc_p2', PAGE_LENGTH),
    { type: 'text', content: 'Done' },
  ]
  let index = 0
  // Snapshot every request: the loop keeps mutating the array it sent.
  const sent: ChatMessage[][] = []
  const next = async (context: ReasoningContext): Promise<RespondResult> => {
    sent.push(structuredClone(context.messages))
    return results[index++] ?? { type: 'error', error: new Error('script exhausted') }
  }
  const reasoning: ReasoningPort = {
    respondWithTools: vi.fn(next),
    continueWithToolResults: vi.fn(next),
  }
  const collapseRuns: string[][] = []
  const manage = vi.fn((messages: ChatMessage[]) => {
    const result = prePrune(messages, DEFAULT_PRE_PRUNE_OPTIONS, PRESSURE_ON)
    collapseRuns.push(result.passesApplied)
    return result.messages
  })
  const config = buildLoopConfig({
    reasoning,
    toolRegistry: makeRegistry(makeReadTool()),
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    conversation: makeFakeConversation(),
    loopController: scenario.loopController,
    contextManager: { manage },
  })

  const outcome = await runToolUseLoop(config, [
    { role: 'user', content: 'Summarize the attached file.' },
  ])
  return { outcome, sent, manage, collapseRuns }
}

describe('LM1 loop-injected user messages keep the current turn for page collapse', () => {
  it.each([
    ['an error-recovery prompt', recoveryScenario],
    ['a nudge from onTextRejected', nudgeScenario],
  ])('keeps both same-turn pages across %s under pressure', async (_, build) => {
    const scenario = build()
    const { outcome, sent, manage } = await runScenario(scenario)

    // Witnesses: the loop ran the whole script, the context manager ran on
    // every iteration, and the injected user message sits between the pages.
    expect(outcome).toMatchObject({ type: 'response', content: 'Done' })
    expect(sent).toHaveLength(4)
    expect(manage.mock.calls.length).toBeGreaterThanOrEqual(4)
    const final = sent[3]!
    const firstPage = final.findIndex(m => m.role === 'tool' && m.tool_call_id === 'tc_p1')
    const injected = final.findIndex(m => m.role === 'user' && m.content === scenario.injected)
    const secondPage = final.findIndex(m => m.role === 'tool' && m.tool_call_id === 'tc_p2')
    expect(firstPage).toBeGreaterThan(0)
    expect(injected).toBeGreaterThan(firstPage)
    expect(secondPage).toBeGreaterThan(injected)

    // Both pages of the current user turn reach the model whole.
    expect(pageText(final[firstPage]!)).toBe(FIRST_PAGE_TEXT)
    expect(pageText(final[secondPage]!)).toBe(SECOND_PAGE_TEXT)
  })

  it.each([
    ['an error-recovery prompt', recoveryScenario],
    ['a nudge from onTextRejected', nudgeScenario],
  ])(
    'witness: a genuine user message in place of %s does collapse the first page',
    async (_, build) => {
      const scenario = build()
      const { sent } = await runScenario(scenario)
      const final = sent[3]!
      const injected = final.findIndex(m => m.role === 'user' && m.content === scenario.injected)
      const firstPage = final.findIndex(m => m.role === 'tool' && m.tool_call_id === 'tc_p1')
      expect(injected).toBeGreaterThan(firstPage)

      // Same transcript, same pressure; only the injected message is replaced by
      // a plain user message carrying the same text.
      const genuine = final.map(
        (m, i): ChatMessage => (i === injected ? { role: 'user', content: m.content } : m)
      )
      const result = prePrune(genuine, DEFAULT_PRE_PRUNE_OPTIONS, PRESSURE_ON)
      expect(result.passesApplied).toContain('attachment_page_collapse')
      expect(pageText(result.messages[firstPage]!)).toBe(COLLAPSE_MARKER)
      expect(pageText(result.messages[final.length - 1]!)).toBe(SECOND_PAGE_TEXT)
    }
  )
})
