/**
 * #666 / #678 — `clerum__attachment_read` pages through `executeSingleTool`
 * with the real tool, safety and `SpilloverStorage`. The tool bounds its own
 * output (the caller chose the page), so the loop ships every page inline
 * and never replaces it with a spillover summary, whatever the threshold. A
 * control tool of the same size proves the storage is live.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import type { IncomingMessage } from '../../../server'
import type { Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { DefaultToolOutputProcessor } from '../../safety/toolOutputProcessor'
import { SpilloverStorage } from '../../spillover'
import { AttachmentReadTool } from '../../tools/attachmentRead'
import type { ToolOutput } from '../../types'
import type { AgentEvent } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { executeSingleTool } from '../toolUseLoop'

const THRESHOLD = 8192
const PAGE_BYTES = 20 * 1024
const READ_LIMIT = 65_536
const TASK_ID = 'attachment-task'
const MESSAGE_ID = '6f1c2a9e-4b7d-4c1e-9a53-2f8e7d6c5b4a'
const ATTACHMENT_ID = 'c3d9e8f7-1a2b-4c5d-8e9f-0a1b2c3d4e5f'
// `sanitized` reports whether redaction changed the output; plain notes do not.
const WRAPPER_OPEN = '<tool_output name="clerum__attachment_read" sanitized="false">\n'
const WRAPPER_CLOSE = '\n</tool_output>'

function attachedFile(bytes: Buffer) {
  const result = validateIncomingAttachments(
    [
      {
        id: ATTACHMENT_ID,
        kind: 'file',
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        filename: 'notes.txt',
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 3_145_728, messageId: MESSAGE_ID }
  )
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  return result.attachments![0]!
}

interface InlinePage {
  attachmentId: string
  kind: string
  byteRange: { offset: number; length: number }
  truncated: boolean
  text: string
}

/** The page as the model receives it: the wrapper is present and the body parses. */
function unwrap(content: string): InlinePage {
  expect(content.startsWith(WRAPPER_OPEN)).toBe(true)
  expect(content.endsWith(WRAPPER_CLOSE)).toBe(true)
  return JSON.parse(content.slice(WRAPPER_OPEN.length, -WRAPPER_CLOSE.length)) as InlinePage
}

/** A sanitized tool with no paging contract: the loop's regular spillover path. */
function unboundedTool(name: string, output: string): Tool {
  return {
    name: () => name,
    description: () => `Mock ${name}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    requiresSanitization: () => true,
    requiresApproval: () => false,
    execute: async (): Promise<ToolOutput> => ({
      content: output,
      duration_ms: 1,
      is_error: false,
    }),
  }
}

describe('executeSingleTool — clerum__attachment_read pages stay inline (#666, #678)', () => {
  let workspace: string
  let storage: SpilloverStorage
  let events: SimpleEventEmitter
  let emitted: AgentEvent[]

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-read-inline-'))
    storage = new SpilloverStorage({
      workspacePath: workspace,
      thresholdBytes: THRESHOLD,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    })
    events = new SimpleEventEmitter()
    emitted = []
    const record = (event: AgentEvent) => {
      emitted.push(event)
    }
    events.on('tool:completed', record)
    events.on('spillover:persisted', record)
  })

  afterEach(async () => {
    storage.stopGc()
    await fs.rm(workspace, { recursive: true, force: true })
  })

  function run(tool: Tool, callId: string, args: Record<string, unknown>) {
    const registry: ToolRegistry = {
      get: name => (name === tool.name() ? tool : null),
      listDefinitions: () => [],
      register: () => undefined,
    }
    const safety = new BasicSafety()
    return executeSingleTool(
      { id: callId, name: tool.name(), arguments: args },
      {
        toolRegistry: registry,
        toolOutputProcessor: new DefaultToolOutputProcessor(safety),
        safety,
        events,
        toolTimeout: 1000,
        progressReporter: undefined,
        toolProgressInterval: 0,
        spilloverStorage: storage,
        taskId: TASK_ID,
      }
    )
  }

  function readerFor(attachment: ReturnType<typeof attachedFile>): AttachmentReadTool {
    const message: IncomingMessage = {
      content: 'Analyze the attached file',
      channelType: 'rpc',
      channelId: 'agent-1',
      sender: 'user-1',
      timestamp: '2026-09-24T10:00:00Z',
      messageId: MESSAGE_ID,
      hostRef: 'host-1',
      attachments: [attachment],
    }
    return new AttachmentReadTool(message, READ_LIMIT)
  }

  function eventTypes(): string[] {
    return emitted.map(event => event.type)
  }

  it('ships a 20 KiB page inline, above the spillover threshold, and writes nothing to disk', async () => {
    const fileText = 'line of notes\n'.repeat(3000)
    const attachment = attachedFile(Buffer.from(fileText))

    const result = await run(readerFor(attachment), 'read-1', {
      attachmentId: ATTACHMENT_ID,
      maxBytes: PAGE_BYTES,
    })

    expect(result.is_error).toBe(false)
    // Witness: the page itself reached the model, with every paging field.
    const page = unwrap(result.content)
    expect(page.attachmentId).toBe(ATTACHMENT_ID)
    expect(page.kind).toBe('text')
    expect(page.byteRange).toEqual({ offset: 0, length: PAGE_BYTES })
    expect(page.truncated).toBe(true)
    expect(page.text).toBe(fileText.slice(0, PAGE_BYTES))
    expect(Buffer.byteLength(result.content, 'utf8')).toBeGreaterThan(THRESHOLD)
    expect(result.spillover_ref).toBeUndefined()
    // Witness for the negative assertions: the call completed and the loop
    // emitted its completion event; the spillover event did not follow it.
    expect(eventTypes()).toContain('tool:completed')
    expect(eventTypes()).not.toContain('spillover:persisted')
    await expect(fs.access(path.join(workspace, 'spillover', TASK_ID))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('ships the last page inline with truncated:false', async () => {
    const fileText = 'line of notes\n'.repeat(2200)
    const bytes = Buffer.from(fileText)
    const attachment = attachedFile(bytes)

    const result = await run(readerFor(attachment), 'read-2', {
      attachmentId: ATTACHMENT_ID,
      offset: PAGE_BYTES,
      maxBytes: PAGE_BYTES,
    })

    expect(result.is_error).toBe(false)
    expect(result.spillover_ref).toBeUndefined()
    const page = unwrap(result.content)
    expect(page.byteRange).toEqual({ offset: PAGE_BYTES, length: bytes.length - PAGE_BYTES })
    expect(page.truncated).toBe(false)
    expect(page.text).toBe(fileText.slice(PAGE_BYTES))
    expect(eventTypes()).toContain('tool:completed')
    expect(eventTypes()).not.toContain('spillover:persisted')
  })

  it('recovers the whole file by following byteRange and truncated through the loop', async () => {
    const fileText = 'line of notes\n'.repeat(3600)
    const bytes = Buffer.from(fileText)
    const attachment = attachedFile(bytes)
    const reader = readerFor(attachment)

    const pages: InlinePage[] = []
    let offset = 0
    do {
      const result = await run(reader, `read-${pages.length + 1}`, {
        attachmentId: ATTACHMENT_ID,
        offset,
        maxBytes: PAGE_BYTES,
      })
      expect(result.is_error).toBe(false)
      expect(result.spillover_ref).toBeUndefined()
      const page = unwrap(result.content)
      expect(page.byteRange.offset).toBe(offset)
      pages.push(page)
      offset = page.byteRange.offset + page.byteRange.length
    } while (pages[pages.length - 1]!.truncated)

    expect(pages.length).toBe(Math.ceil(bytes.length / PAGE_BYTES))
    expect(pages.map(page => page.text).join('')).toBe(fileText)
    expect(emitted.filter(event => event.type === 'tool:completed')).toHaveLength(pages.length)
    expect(eventTypes()).not.toContain('spillover:persisted')
  })

  it('control: an unbounded sanitized tool of the same size still spills through the same storage', async () => {
    const output = JSON.stringify({ text: 'line of notes\n'.repeat(1500) })

    const result = await run(unboundedTool('file_read', output), 'control-1', {})

    expect(result.is_error).toBe(false)
    expect(result.spillover_ref).toBe(`spillover://${TASK_ID}/control-1.json`)
    expect(eventTypes()).toContain('spillover:persisted')
    const blob = await storage.load(result.spillover_ref!)
    expect(blob?.content).toContain(output.slice(0, 200))
  })
})
