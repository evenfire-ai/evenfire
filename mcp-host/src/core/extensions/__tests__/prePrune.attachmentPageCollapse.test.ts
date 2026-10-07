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
import { createHash } from 'node:crypto'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import type { IncomingMessage } from '../../../server'
import { AttachmentReadLedger } from '../../attachments/attachmentReadBudget'
import type { ToolRegistry } from '../../interfaces'
import { SimpleEventEmitter } from '../../orchestration/eventEmitter'
import { executeSingleTool, validateToolLinkages } from '../../orchestration/toolUseLoop'
import { BasicSafety } from '../../safety/safety'
import { DefaultToolOutputProcessor } from '../../safety/toolOutputProcessor'
import { AttachmentReadTool } from '../../tools/attachmentRead'
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
const safety = new BasicSafety()

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
  // Exercise the exact pure wrapper used to measure and emit real tool output.
  return safety.previewOutputForLlm(toolName, content)
}

function stubMarker(): string {
  // M3: a later turn has no attachment_read tool for this file unless the
  // user attaches it again, so the stub must say so instead of "re-read".
  return '[earlier attachment page collapsed; reattach the file in a new message to re-read it, and resume reading at nextOffset]'
}

/**
 * Liveness witness for the negative assertions below: the page at `index`
 * of `messages` was replaced by a collapse stub, so the pass did run.
 */
function expectCollapsedAt(messages: ChatMessage[], index: number): void {
  expect((JSON.parse(messages[index]!.content) as Record<string, unknown>).text).toBe(stubMarker())
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
    expectCollapsedAt(prePruneModule.collapseEarlierAttachmentPages(conversation()), 2)
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
      out[2].content.startsWith('<tool_output name="clerum__attachment_read" sanitized="false">')
    ).toBe(true)
    expect(out[2].content.endsWith('</tool_output>')).toBe(true)
    const inner = out[2].content.split('\n')[1]!
    expect((JSON.parse(inner) as Record<string, unknown>).text).toBe(stubMarker())
  })

  it('keeps current-turn pages byte-identical and referentially intact', () => {
    const messages = conversation()
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)
    expectCollapsedAt(out, 2)
    expect(out[5]).toBe(messages[5])
    expect(out[5].content).toBe(messages[5].content)
  })

  it('collapses paged results with nextOffset and keeps the validated continuation fields', () => {
    const messages = conversation()
    messages[2] = attachmentToolResult(
      'tc_old',
      wrapped(
        nativePage({
          limit: 'page_budget',
          nextOffset: 65536,
        })
      )
    )
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)
    const stub = JSON.parse(out[2].content.split('\n')[1]!)
    expect(stub.text).toBe(stubMarker())
    expect(stub.limit).toBe('page_budget')
    expect(stub.nextOffset).toBe(65536)
    expect(out[5]).toBe(messages[5])
    expect(() => validateToolLinkages(out)).not.toThrow()
  })

  it('keeps continuation metadata after a second pressured pre-prune of a real wrapper', () => {
    const messages = conversation()
    messages[2] = attachmentToolResult(
      'tc_old',
      wrapped(
        nativePage({
          limit: 'page_budget',
          nextOffset: 65536,
        })
      )
    )

    const first = prePrune(messages, OPTIONS, PRESSURE_ON)
    const second = prePrune(first.messages, OPTIONS, PRESSURE_ON)
    expect(first.passesApplied).toContain('attachment_page_collapse')
    expect(second.messages[2]).toBe(first.messages[2])
    expect(second.messages[2].content.endsWith('</tool_output>')).toBe(true)
    const stub = JSON.parse(second.messages[2].content.split('\n')[1]!)
    expect(stub.byteRange).toEqual({ offset: 0, length: 65536 })
    expect(stub.limit).toBe('page_budget')
    expect(stub.nextOffset).toBe(65536)
    expect(stub.text).toBe(stubMarker())
    expect(() => validateToolLinkages(second.messages)).not.toThrow()
  })

  it('does not start another turn when a tool supplies a synthetic image user message', () => {
    const messages = conversation()
    messages.push({ role: 'user', content: 'tool-supplied image', imageOrigin: 'tool_result' })
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)
    expect(JSON.parse(out[2].content).text).toBe(stubMarker())
    expect(out[5]).toBe(messages[5])
    expect(out[5].content).toBe(messages[5].content)
  })

  it('leaves corrupt continuation metadata untouched with a valid continuation witness', () => {
    const valid = conversation()
    valid[2] = attachmentToolResult('tc_old', nativePage({ nextOffset: 65536 }))
    expect(JSON.parse(prePruneModule.collapseEarlierAttachmentPages(valid)[2].content).text).toBe(
      stubMarker()
    )
    for (const fields of [
      { nextOffset: 1 },
      { nextOffset: -1 },
      { nextOffset: '65536' },
      { nextOffset: 65536, truncated: false },
      { limit: 'invented_limit' },
    ]) {
      const messages = conversation()
      messages[2] = attachmentToolResult('tc_old', nativePage(fields))
      expect(prePruneModule.collapseEarlierAttachmentPages(messages)[2]).toBe(messages[2])
    }
  })

  it('keeps untouched messages referentially identical and originals immutable', () => {
    const messages = conversation()
    const before = structuredClone(messages)
    const out = prePruneModule.collapseEarlierAttachmentPages(messages)
    expectCollapsedAt(out, 2)
    expect(messages).toEqual(before)
    for (const i of [0, 1, 3, 4, 5]) expect(out[i]).toBe(messages[i])
  })

  it('is idempotent: a second pass returns the same array reference', () => {
    const messages = conversation()
    const once = prePruneModule.collapseEarlierAttachmentPages(messages)
    expect(once).not.toBe(messages)
    expectCollapsedAt(once, 2)
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
      // Witness: a genuine page in the same input collapses, so the pass ran.
      assistantToolCall('tc_g', 'clerum__attachment_read', { attachmentId: 'att_1' }),
      attachmentToolResult('tc_g', nativePage()),
      userMsg('now'),
    ]
    const wrappedForeign = wrapped(nativePage(), 'clerum__gfs_read')
    malformed.push(attachmentToolResult('tc_w', wrappedForeign))

    const input = [foreignTool, ...malformed]
    const genuineIndex = input.findIndex(m => m.role === 'tool' && m.tool_call_id === 'tc_g')
    const out = prePruneModule.collapseEarlierAttachmentPages(input)
    expect(out).not.toBe(input)
    expectCollapsedAt(out, genuineIndex)
    for (let i = 0; i < input.length; i++) {
      if (i !== genuineIndex) expect(out[i]).toBe(input[i])
    }
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
    // Witness: the same messages collapse once pressure is supplied.
    const pressured = prePrune(messages, OPTIONS, PRESSURE_ON)
    expect(pressured.passesApplied).toContain('attachment_page_collapse')
    expectCollapsedAt(pressured.messages, 2)
  })

  it('does not collapse below the 0.8 window threshold', () => {
    const messages = conversation()
    const result = prePrune(messages, OPTIONS, PRESSURE_OFF)
    expect(result.messages[2]).toBe(messages[2])
    expect(result.passesApplied).not.toContain('attachment_page_collapse')
    // Witness: exactly at the threshold the same messages collapse.
    const atThreshold = prePrune(messages, OPTIONS, { inputTokens: 800, contextWindowTokens: 1000 })
    expect(atThreshold.passesApplied).toContain('attachment_page_collapse')
    expectCollapsedAt(atThreshold.messages, 2)
  })

  it('does not collapse when the option is explicitly disabled', () => {
    const messages = conversation()
    const result = prePrune(
      messages,
      { ...OPTIONS, attachmentPageCollapseEnabled: false },
      PRESSURE_ON
    )
    expect(result.messages[2]).toBe(messages[2])
    expect(result.passesApplied).not.toContain('attachment_page_collapse')
    // Witness: the same call with the option left on collapses.
    const enabled = prePrune(messages, OPTIONS, PRESSURE_ON)
    expect(enabled.passesApplied).toContain('attachment_page_collapse')
    expectCollapsedAt(enabled.messages, 2)
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
      expect(result.passesApplied).not.toContain('attachment_page_collapse')
    }
    // Witness: a finite qualifying snapshot collapses the same messages.
    const valid = prePrune(messages, OPTIONS, PRESSURE_ON)
    expect(valid.passesApplied).toContain('attachment_page_collapse')
    expectCollapsedAt(valid.messages, 2)
  })
})

describe('C17 prePrune — real attachment_read producer (M1, L14)', () => {
  const ATTACHMENT_ID = 'c3d9e8f7-1a2b-4c5d-8e9f-0a1b2c3d4e5f'
  const MESSAGE_ID = '6f1c2a9e-4b7d-4c1e-9a53-2f8e7d6c5b4a'
  const OPEN = '<tool_output name="clerum__attachment_read" sanitized="true">\n'
  const CLOSE = '\n</tool_output>'

  function parsesAsJson(text: string): boolean {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  }

  function readerFor(bytes: Buffer): AttachmentReadTool {
    const admitted = validateIncomingAttachments(
      [
        {
          id: ATTACHMENT_ID,
          kind: 'file',
          mimeType: 'text/plain',
          detectedMediaType: 'text/plain',
          encoding: 'base64',
          dataBase64: bytes.toString('base64'),
          filename: 'service.env',
          sizeBytes: bytes.length,
          digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
        },
      ],
      { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 3_145_728, messageId: MESSAGE_ID }
    )
    if (!admitted.ok) throw new Error(`fixture rejected: ${admitted.error.code}`)
    const message: IncomingMessage = {
      content: 'Review the attached config',
      channelType: 'rpc',
      channelId: 'agent-1',
      sender: 'user-1',
      timestamp: '2026-10-06T10:00:00Z',
      messageId: MESSAGE_ID,
      hostRef: 'host-1',
      attachments: admitted.attachments,
    }
    return new AttachmentReadTool(message, 65_536, {
      contextWindowTokens: 100_000,
      ledger: new AttachmentReadLedger(),
      redactor: new BasicSafety(),
    })
  }

  it('collapses an env-dump page whose PWD= match runs across its newline escapes', async () => {
    const head = 'PWD=/app\nHOME=/root\nPORT=5432'
    const fileText = `${head}\nUSER=app\n`
    const tool = readerFor(Buffer.from(fileText))
    const registry: ToolRegistry = {
      get: name => (name === tool.name() ? tool : null),
      listDefinitions: () => [],
      register: () => undefined,
    }
    const result = await executeSingleTool(
      {
        id: 'tc_env_dump',
        name: 'clerum__attachment_read',
        arguments: { attachmentId: ATTACHMENT_ID, maxBytes: Buffer.byteLength(head) },
      },
      {
        toolRegistry: registry,
        toolOutputProcessor: new DefaultToolOutputProcessor(safety),
        safety,
        events: new SimpleEventEmitter(),
        toolTimeout: 1000,
        progressReporter: undefined,
        toolProgressInterval: 0,
        measureToolMessage: message =>
          Math.max(Math.ceil(Buffer.byteLength(message.content ?? '', 'utf8') / 4) + 4, 1),
      }
    )

    expect(result.is_error).toBe(false)
    expect(result.content.startsWith(OPEN)).toBe(true)
    expect(result.content.endsWith(CLOSE)).toBe(true)
    const inner = result.content.slice(OPEN.length, -CLOSE.length)
    expect(parsesAsJson(inner)).toBe(true)
    expect(JSON.parse(inner).nextOffset).toBe(Buffer.byteLength(head))
    expect(inner).not.toContain('HOME=/root')

    const messages: ChatMessage[] = [
      userMsg('Review the attached config'),
      assistantToolCall('tc_env_dump', 'clerum__attachment_read', { attachmentId: ATTACHMENT_ID }),
      { role: 'tool', tool_call_id: 'tc_env_dump', name: result.name, content: result.content },
      userMsg('next turn'),
    ]
    const pruned = prePrune(messages, OPTIONS, PRESSURE_ON)
    expect(pruned.passesApplied).toContain('attachment_page_collapse')
    const stub = JSON.parse(pruned.messages[2].content.slice(OPEN.length, -CLOSE.length))
    expect(stub).toEqual({
      attachmentId: ATTACHMENT_ID,
      referenceId: expect.any(String),
      kind: 'text',
      byteRange: { offset: 0, length: Buffer.byteLength(head) },
      truncated: true,
      limit: 'max_bytes',
      nextOffset: Buffer.byteLength(head),
      text: stubMarker(),
    })
    expect(() => validateToolLinkages(pruned.messages)).not.toThrow()
  })

  it('collapses a page whose text ends inside password=<value> and keeps its paging fields', async () => {
    const head = 'DB_HOST=db.internal\npassword=supersecret99'
    const fileText = `${head}\nPORT=5432\n`
    const tool = readerFor(Buffer.from(fileText))
    const registry: ToolRegistry = {
      get: name => (name === tool.name() ? tool : null),
      listDefinitions: () => [],
      register: () => undefined,
    }
    const result = await executeSingleTool(
      {
        id: 'tc_env',
        name: 'clerum__attachment_read',
        arguments: { attachmentId: ATTACHMENT_ID, maxBytes: Buffer.byteLength(head) },
      },
      {
        toolRegistry: registry,
        toolOutputProcessor: new DefaultToolOutputProcessor(safety),
        safety,
        events: new SimpleEventEmitter(),
        toolTimeout: 1000,
        progressReporter: undefined,
        toolProgressInterval: 0,
        measureToolMessage: message =>
          Math.max(Math.ceil(Buffer.byteLength(message.content ?? '', 'utf8') / 4) + 4, 1),
      }
    )

    // The stored output: the real wrapper around a page that still parses.
    // The tool masks the value against the whole text (jozer-rami M2), so the
    // loop's sanitizer finds nothing left to change.
    const open = '<tool_output name="clerum__attachment_read" sanitized="false">\n'
    expect(result.is_error).toBe(false)
    expect(result.content.startsWith(open)).toBe(true)
    expect(result.content.endsWith(CLOSE)).toBe(true)
    const inner = result.content.slice(open.length, -CLOSE.length)
    expect(parsesAsJson(inner)).toBe(true)
    expect(JSON.parse(inner).text).toBe('DB_HOST=db.internal\n[REDACTED]')
    expect(inner).not.toContain('supersecret99')

    const messages: ChatMessage[] = [
      userMsg('Review the attached config'),
      assistantToolCall('tc_env', 'clerum__attachment_read', { attachmentId: ATTACHMENT_ID }),
      { role: 'tool', tool_call_id: 'tc_env', name: result.name, content: result.content },
      userMsg('next turn'),
    ]
    const pruned = prePrune(messages, OPTIONS, PRESSURE_ON)
    expect(pruned.passesApplied).toContain('attachment_page_collapse')
    const stubContent = pruned.messages[2].content
    expect(stubContent.startsWith(open)).toBe(true)
    const stub = JSON.parse(stubContent.slice(open.length, -CLOSE.length))
    expect(stub).toEqual({
      attachmentId: ATTACHMENT_ID,
      referenceId: expect.any(String),
      kind: 'text',
      byteRange: { offset: 0, length: Buffer.byteLength(head) },
      truncated: true,
      limit: 'max_bytes',
      nextOffset: Buffer.byteLength(head),
      text: stubMarker(),
    })
    expect(() => validateToolLinkages(pruned.messages)).not.toThrow()
  })
})
