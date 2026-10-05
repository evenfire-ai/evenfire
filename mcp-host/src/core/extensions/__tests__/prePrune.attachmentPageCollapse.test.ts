/**
 * C17 — `collapseEarlierAttachmentPages` pre-prune pass.
 *
 * Covers the frozen contract: only genuine native text-page results of
 * `clerum__attachment_read` that live strictly before the LATEST user message
 * collapse into small stubs. Current-turn pages, foreign tools, malformed
 * shapes, linkage fields and the protected-tail semantics of the other passes
 * stay untouched. The pass is pressure-gated inside `prePrune`.
 */
import { describe, expect, it } from 'vitest'
import { validateToolLinkages } from '../../orchestration/toolUseLoop'
import type { ChatMessage } from '../../types'
import {
  DEFAULT_PRE_PRUNE_OPTIONS,
  type PrePruneOptions,
  type PrePrunePressure,
  prePrune,
} from '../prePrune'
import * as prePruneModule from '../prePrune'

const PAGE_TEXT = 'confidential page body '.repeat(200)
const FILENAME = 'strategy-2027.md'

function userMsg(content: string): ChatMessage {
  return { role: 'user', content }
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return { role: 'assistant', content: '', tool_calls: [{ id, name, arguments: args }] }
}

function attachmentToolResult(id: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, name: 'clerum__attachment_read', content }
}

function nativePage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    attachmentId: 'att_1',
    referenceId: 'ref_sha256 deadbeef',
    kind: 'text',
    byteRange: { offset: 0, length: 65536 },
    truncated: true,
    text: PAGE_TEXT,
    ...overrides,
  })
}

function wrapped(content: string, toolName = 'clerum__attachment_read'): string {
  return `<tool_output name="${toolName}" sanitized="true">\n${content}\n</tool_output>`
}

function stubMarker(): string {
  return '[earlier attachment page collapsed; re-read with clerum__attachment_read if needed]'
}

const PRESSURE_ON: PrePrunePressure = { inputTokens: 900, contextWindowTokens: 1000 }
const PRESSURE_OFF: PrePrunePressure = { inputTokens: 799, contextWindowTokens: 1000 }
const OPTIONS: PrePruneOptions = { ...DEFAULT_PRE_PRUNE_OPTIONS }

/** Two-turn conversation: one old page, one current-turn page. */
function conversation(): ChatMessage[] {
  return [
    userMsg(`first turn, see ${FILENAME}`),
    assistantToolCall('tc_old', 'clerum__attachment_read', { attachmentId: 'att_1' }),
    attachmentToolResult('tc_old', nativePage()),
    userMsg('second turn'),
    assistantToolCall('tc_cur', 'clerum__attachment_read', { attachmentId: 'att_1' }),
    attachmentToolResult('tc_cur', nativePage({ byteRange: { offset: 65536, length: 100 } })),
  ]
}

describe('C17 collapseEarlierAttachmentPages — export', () => {
  it('exports the frozen collapseEarlierAttachmentPages function', () => {
    expect(typeof prePruneModule.collapseEarlierAttachmentPages).toBe('function')
  })
})

describe('C17 collapseEarlierAttachmentPages — direct pass', () => {
  it('collapses a genuine old-turn native page and preserves identity + paging + linkage', () => {
    const messages = conversation()
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)

    expect(out).not.toBe(messages)
    expect(out[2]).not.toBe(messages[2])
    const stub = JSON.parse(out[2].content) as Record<string, unknown>
    expect(stub.attachmentId).toBe('att_1')
    expect(stub.referenceId).toBe('ref_sha256 deadbeef')
    expect(stub.kind).toBe('text')
    expect(stub.byteRange).toEqual({ offset: 0, length: 65536 })
    expect(stub.truncated).toBe(true)
    expect(stub.text).toBe(stubMarker())
    expect(out[2].tool_call_id).toBe('tc_old')
    expect(out[2].name).toBe('clerum__attachment_read')
    expect(() => validateToolLinkages(out)).not.toThrow()
  })

  it('leaks no raw page text or filename into the stub', () => {
    const messages = conversation()
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)
    expect(out[2].content).not.toContain('confidential page body')
    expect(out[2].content).not.toContain(FILENAME)
    expect(out[2].content.length).toBeLessThan(messages[2].content.length / 4)
  })

  it('preserves the sanitized wrapper around the stub', () => {
    const messages = conversation()
    messages[2] = attachmentToolResult('tc_old', wrapped(nativePage()))
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)

    expect(
      out[2].content.startsWith('<tool_output name="clerum__attachment_read" sanitized="true">')
    ).toBe(true)
    expect(out[2].content.endsWith('</tool_output>')).toBe(true)
    const inner = out[2].content.split('\n')[1]!
    expect((JSON.parse(inner) as Record<string, unknown>).text).toBe(stubMarker())
  })

  it('keeps current-turn pages byte-identical and referentially intact', () => {
    const messages = conversation()
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)
    expect(out[5]).toBe(messages[5])
    expect(out[5].content).toBe(messages[5].content)
  })

  it('keeps untouched messages referentially identical and originals immutable', () => {
    const messages = conversation()
    const before = structuredClone(messages)
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)
    expect(messages).toEqual(before)
    for (const i of [0, 1, 3, 4, 5]) expect(out[i]).toBe(messages[i])
  })

  it('is idempotent: a second pass returns the same array reference', () => {
    const messages = conversation()
    const once = prePruneModule.collapseEarlierAttachmentPages(messages)
    const twice = prePruneModule.collapseEarlierAttachmentPages(once)
    expect(twice).toBe(once)
  })

  it('leaves other tools, malformed and foreign shapes unchanged', () => {
    const foreignTool: ChatMessage = {
      role: 'tool',
      tool_call_id: 'tc_gfs',
      name: 'clerum__gfs_read',
      content: nativePage(),
    }
    const malformed: ChatMessage[] = [
      userMsg('q'),
      assistantToolCall('tc_m', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_m', '{"attachmentId":"att_1","kind":"text"'),
      assistantToolCall('tc_x', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_x', nativePage({ truncated: 'yes' })),
      assistantToolCall('tc_b', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_b', nativePage({ kind: 'binary' })),
      assistantToolCall('tc_e', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_e', nativePage({ extra: true })),
      userMsg('now'),
    ]
    const wrappedForeign = wrapped(nativePage(), 'clerum__gfs_read')
    malformed.push(attachmentToolResult('tc_w', wrappedForeign))

    const input = [foreignTool, ...malformed]
    const out = prePruneModule.collapseEarlierAttachmentPages(input)
    expect(out).toBe(input)
  })

  it('uses the latest-user boundary, not the protected-tail boundary', () => {
    // Four user messages: protectedTailTurns=3 protects from user B onwards
    // (index 3), but the collapse contract protects only from the LATEST user
    // (index 7). Page p2 at index 5 is before the latest user and must collapse
    // even though it sits inside the default protected tail.
    const messages: ChatMessage[] = [
      userMsg('A'),
      assistantToolCall('tc_1', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_1', nativePage()),
      userMsg('B'),
      assistantToolCall('tc_2', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_2', nativePage()),
      userMsg('C'),
      userMsg('D'),
      assistantToolCall('tc_3', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_3', nativePage()),
    ]
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)
    expect(JSON.parse(out[2].content).text).toBe(stubMarker())
    expect(JSON.parse(out[5].content).text).toBe(stubMarker())
    expect(out[9]).toBe(messages[9])
  })
})

describe('C17 prePrune — pressure-gated wiring', () => {
  it('runs the pass before dedup under qualifying pressure', () => {
    const messages: ChatMessage[] = [
      userMsg('A'),
      assistantToolCall('tc_1', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_1', nativePage()),
      assistantToolCall('tc_2', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_2', nativePage()),
      userMsg('B'),
      userMsg('C'),
      userMsg('D'),
    ]
    const result = prePrune(messages, OPTIONS, PRESSURE_ON)
    expect(result.passesApplied[0]).toBe('attachment_page_collapse')
    expect(result.passesApplied).toContain('dedup')
    expect(JSON.parse(result.messages[2].content).text).toBe(stubMarker())
    expect(result.messages[4].content).toBe('[duplicate of tool_call_id=tc_1]')
  })

  it('does not collapse without pressure', () => {
    const messages = conversation()
    const result = prePrune(messages, OPTIONS)
    expect(result.messages[2]).toBe(messages[2])
    expect(result.passesApplied).not.toContain('attachment_page_collapse')
  })

  it('does not collapse below the 0.8 window threshold', () => {
    const messages = conversation()
    const result = prePrune(messages, OPTIONS, PRESSURE_OFF)
    expect(result.messages[2]).toBe(messages[2])
  })

  it('does not collapse when the option is explicitly disabled', () => {
    const messages = conversation()
    const result = prePrune(
      messages,
      { ...OPTIONS, attachmentPageCollapseEnabled: false },
      PRESSURE_ON
    )
    expect(result.messages[2]).toBe(messages[2])
  })

  it('rejects non-finite or non-positive windows and non-finite input tokens', () => {
    const messages = conversation()
    const bad: PrePrunePressure[] = [
      { inputTokens: 900, contextWindowTokens: 0 },
      { inputTokens: 900, contextWindowTokens: Number.POSITIVE_INFINITY },
      { inputTokens: 900, contextWindowTokens: Number.NaN },
      { inputTokens: Number.POSITIVE_INFINITY, contextWindowTokens: 1000 },
      { inputTokens: Number.NaN, contextWindowTokens: 1000 },
    ]
    for (const pressure of bad) {
      const result = prePrune(messages, OPTIONS, pressure)
      expect(result.messages[2]).toBe(messages[2])
    }
  })
})
