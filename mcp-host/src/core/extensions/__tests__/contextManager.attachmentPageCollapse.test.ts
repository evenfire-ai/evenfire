/**
 * L17 — `PressureContextManager.manage` hands its measured pressure to
 * `prePrune`, which gates the C17 attachment page collapse on it. Witnessed both
 * ways on the same conversation: under pressure the earlier-turn page
 * collapses, without pressure the manager passes the history through untouched.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { heuristicCount } from '../../tokenizer/heuristic'
import type { ChatMessage } from '../../types'
import { PressureContextManager } from '../contextManager'
import { DEFAULT_PRE_PRUNE_OPTIONS } from '../prePrune'

const PAGE_TEXT = 'earlier turn page body '.repeat(2000)
const COLLAPSE_MARKER =
  '[earlier attachment page collapsed; reattach the file in a new message to re-read it, and resume reading at nextOffset]'

function conversation(): ChatMessage[] {
  return [
    { role: 'user', content: 'Summarize the attached file.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc_old', name: 'clerum__attachment_read', arguments: { attachmentId: 'att_1' } },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'tc_old',
      name: 'clerum__attachment_read',
      content: JSON.stringify({
        attachmentId: 'att_1',
        referenceId: 'ref_sha256 deadbeef',
        kind: 'text',
        byteRange: { offset: 0, length: 65536 },
        truncated: true,
        limit: 'max_bytes',
        nextOffset: 65536,
        text: PAGE_TEXT,
      }),
    },
    { role: 'assistant', content: 'Here is the summary of the first page.' },
    { role: 'user', content: 'Thanks, now something unrelated.' },
  ]
}

function managerFor(maxTokens: number) {
  const emit = vi.fn()
  const manager = new PressureContextManager(maxTokens, undefined, undefined, undefined, {
    prePruneEnabled: true,
    prePruneOptions: { ...DEFAULT_PRE_PRUNE_OPTIONS },
    events: { emit, on: vi.fn(), off: vi.fn() },
  })
  return { manager, emit }
}

function prePruneEvents(emit: ReturnType<typeof vi.fn>): Array<{ data: Record<string, unknown> }> {
  return emit.mock.calls
    .map(([event]) => event as { type: string; data: Record<string, unknown> })
    .filter(event => event.type === 'compaction:pre_prune_executed')
}

function pageText(message: ChatMessage): string {
  return (JSON.parse(message.content) as { text: string }).text
}

describe('L17 PressureContextManager wires its pressure into the attachment page collapse', () => {
  const tokens = heuristicCount(conversation())

  it('collapses an earlier-turn page when the manager measures pressure at or above 0.8', async () => {
    // A window slightly larger than the history: pressure is about 0.9.
    const { manager, emit } = managerFor(Math.ceil(tokens / 0.9))
    const messages = conversation()

    const out = await manager.manage(messages, makeFakeConversation())

    expect(out).not.toBe(messages)
    expect(pageText(out[2]!)).toBe(COLLAPSE_MARKER)
    expect(JSON.parse(out[2]!.content)).toMatchObject({ nextOffset: 65536, limit: 'max_bytes' })
    const events = prePruneEvents(emit)
    expect(events).toHaveLength(1)
    expect(events[0]!.data.passesApplied).toEqual(['attachment_page_collapse'])
    // The input array is never mutated.
    expect(pageText(messages[2]!)).toBe(PAGE_TEXT)
  })

  it('passes the history through untouched when the manager measures no pressure', async () => {
    // A window ten times the history: pressure is about 0.1.
    const { manager, emit } = managerFor(tokens * 10)
    const messages = conversation()

    const out = await manager.manage(messages, makeFakeConversation())

    expect(out).toBe(messages)
    expect(pageText(out[2]!)).toBe(PAGE_TEXT)
    expect(prePruneEvents(emit)).toHaveLength(0)

    // Witness: the same conversation and options collapse once the window
    // puts the manager under pressure, so the pass was reachable here.
    const pressured = managerFor(Math.ceil(tokens / 0.9))
    const collapsed = await pressured.manager.manage(conversation(), makeFakeConversation())
    expect(pageText(collapsed[2]!)).toBe(COLLAPSE_MARKER)
    expect(prePruneEvents(pressured.emit)).toHaveLength(1)
  })
})
