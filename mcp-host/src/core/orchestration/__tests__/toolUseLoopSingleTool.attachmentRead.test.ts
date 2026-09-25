/**
 * #666 — `clerum__attachment_read` pages through `executeSingleTool` with the
 * real tool, safety and `SpilloverStorage`. Spillover keeps the first and last
 * 400 characters of the serialized result, so a spilled page must still show
 * the model its paging fields in `head`; a page under the threshold stays
 * inline and writes nothing to disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import type { IncomingMessage } from '../../../server'
import type { ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { DefaultToolOutputProcessor } from '../../safety/toolOutputProcessor'
import { SpilloverStorage, type SpilloverSummary } from '../../spillover'
import { AttachmentReadTool } from '../../tools/attachmentRead'
import { SimpleEventEmitter } from '../eventEmitter'
import { executeSingleTool } from '../toolUseLoop'

const THRESHOLD = 8192
const PAGE_BYTES = 20 * 1024
const TASK_ID = 'attachment-task'
// Desktop sends UUID message and attachment ids; the reference id embeds both
// plus the sha256, so these are the lengths the summary head has to hold.
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

/** The page text as it appears inside the serialized result. */
function serializedText(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

describe('executeSingleTool — clerum__attachment_read and the spillover threshold (#666)', () => {
  let workspace: string
  let storage: SpilloverStorage

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-read-spill-'))
    storage = new SpilloverStorage({
      workspacePath: workspace,
      thresholdBytes: THRESHOLD,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    })
  })

  afterEach(async () => {
    storage.stopGc()
    await fs.rm(workspace, { recursive: true, force: true })
  })

  async function readPage(
    attachment: ReturnType<typeof attachedFile>,
    callId: string,
    args: Record<string, unknown>
  ) {
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
    const tool = new AttachmentReadTool(message, 262_144, THRESHOLD)
    const registry: ToolRegistry = {
      get: name => (name === tool.name() ? tool : null),
      listDefinitions: () => [],
      register: () => undefined,
    }
    const safety = new BasicSafety()
    return executeSingleTool(
      {
        id: callId,
        name: 'clerum__attachment_read',
        arguments: { attachmentId: ATTACHMENT_ID, ...args },
      },
      {
        toolRegistry: registry,
        toolOutputProcessor: new DefaultToolOutputProcessor(safety),
        safety,
        events: new SimpleEventEmitter(),
        toolTimeout: 1000,
        progressReporter: undefined,
        toolProgressInterval: 0,
        spilloverStorage: storage,
        taskId: TASK_ID,
      }
    )
  }

  it('spills a 20 KB page into a summary whose head carries the paging fields', async () => {
    const fileText = 'line of notes\n'.repeat(3000)
    const attachment = attachedFile(Buffer.from(fileText))
    const pageText = fileText.slice(0, PAGE_BYTES)

    const result = await readPage(attachment, 'read-1', { maxBytes: PAGE_BYTES })

    expect(result.is_error).toBe(false)
    expect(result.spillover_ref).toBe(`spillover://${TASK_ID}/read-1.json`)
    const summary = JSON.parse(result.content) as SpilloverSummary
    expect(summary.byte_size).toBeGreaterThan(PAGE_BYTES)
    // The model sees the result inside the tool_output wrapper.
    expect(summary.head.startsWith(`${WRAPPER_OPEN}{"attachmentId":"${ATTACHMENT_ID}"`)).toBe(true)
    expect(summary.head).toContain(`"referenceId":"${attachment.fileReference!.id}"`)
    expect(summary.head).toContain('"kind":"text"')
    expect(summary.head).toContain(`"byteRange":{"offset":0,"length":${PAGE_BYTES}}`)
    expect(summary.head).toContain('"truncated":true')
    // Witness that head reached the text field: every paging field precedes it.
    expect(summary.head).toContain('"text":"')
    expect(summary.tail).toContain(serializedText(pageText).slice(-100))
    expect(summary.tail.endsWith(`"}${WRAPPER_CLOSE}`)).toBe(true)
    // What the model is told about the content: plain text with no hint.
    expect(summary.content_type).toBe('text/plain')
    expect(summary.structure_hint).toBeNull()

    // The spilled blob keeps the page and the reference id; it never holds
    // the attachment's base64 or the file name.
    const blob = await storage.load(result.spillover_ref!)
    expect(blob?.content).toContain(serializedText(pageText))
    expect(blob?.content).toContain(attachment.fileReference!.id)
    expect(blob?.content).not.toContain(attachment.dataBase64)
    expect(blob?.content).not.toContain('notes.txt')
  })

  it('reports truncated:false in the head of the last spilled page', async () => {
    const fileText = 'line of notes\n'.repeat(2200)
    const bytes = Buffer.from(fileText)
    const attachment = attachedFile(bytes)

    const result = await readPage(attachment, 'read-2', {
      offset: PAGE_BYTES,
      maxBytes: PAGE_BYTES,
    })

    expect(result.is_error).toBe(false)
    expect(result.spillover_ref).toBe(`spillover://${TASK_ID}/read-2.json`)
    const summary = JSON.parse(result.content) as SpilloverSummary
    expect(summary.head).toContain(
      `"byteRange":{"offset":${PAGE_BYTES},"length":${bytes.length - PAGE_BYTES}}`
    )
    expect(summary.head).toContain('"truncated":false')
    expect(summary.tail).toContain(serializedText(fileText).slice(-100))
  })

  it('returns a page under the threshold inline and writes nothing to disk', async () => {
    const fileText = 'line of notes\n'.repeat(3000)
    const attachment = attachedFile(Buffer.from(fileText))

    const result = await readPage(attachment, 'read-3', { maxBytes: 1024 })

    expect(result.is_error).toBe(false)
    expect(result.spillover_ref).toBeUndefined()
    // Witness: the page itself reached the model inline.
    expect(result.content.startsWith(WRAPPER_OPEN)).toBe(true)
    expect(result.content.endsWith(WRAPPER_CLOSE)).toBe(true)
    const body = JSON.parse(result.content.slice(WRAPPER_OPEN.length, -WRAPPER_CLOSE.length)) as {
      text: string
      truncated: boolean
    }
    expect(body.text).toBe(fileText.slice(0, 1024))
    expect(body.truncated).toBe(true)
    await expect(fs.access(path.join(workspace, 'spillover', TASK_ID))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
