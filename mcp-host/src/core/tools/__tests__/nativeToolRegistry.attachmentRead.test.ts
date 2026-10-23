/**
 * #666 — `clerum__attachment_read` is presented only for a message that
 * carries `kind:'file'` attachments, and registering it requires its limit.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import type { IncomingMessage } from '../../../server'
import { AttachmentReadLedger } from '../../attachments/attachmentReadBudget'
import type { NativeToolConfig } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { SpilloverStorage } from '../../spillover'
import type { Attachment } from '../../types'
import { NativeToolRegistry } from '../nativeToolRegistry'

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
  attachmentTextReadMaxBytes: 65_536,
}

function attachments(kind: 'file' | 'image'): Attachment[] {
  const bytes =
    kind === 'file'
      ? Buffer.from('notes')
      : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const raw =
    kind === 'file'
      ? {
          id: 'file-1',
          kind: 'file',
          mimeType: 'text/plain',
          detectedMediaType: 'text/plain',
          encoding: 'base64',
          dataBase64: bytes.toString('base64'),
          filename: 'notes.txt',
          sizeBytes: bytes.length,
          digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
        }
      : {
          id: 'image-1',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: bytes.toString('base64'),
        }
  const result = validateIncomingAttachments([raw], {
    maxCount: 20,
    maxBytes: 1_000_000,
    maxFileBytes: 3_145_728,
    messageId: 'message-1',
  })
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  return result.attachments!
}

function message(attached?: Attachment[]): IncomingMessage {
  return {
    content: 'Analyze the attached file',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-09-24T10:00:00Z',
    messageId: 'message-1',
    hostRef: 'host-1',
    ...(attached ? { attachments: attached } : {}),
  }
}

function toolNames(registry: NativeToolRegistry): string[] {
  return registry.listDefinitions().map(definition => definition.name)
}

/** C15/C16 — the per-turn ledger and window a real caller always supplies. */
function attachmentOptions(
  ledger: AttachmentReadLedger = new AttachmentReadLedger(),
  contextWindowTokens = 100_000
) {
  return { maxBytes: 3_145_728, ledger, contextWindowTokens }
}

describe('NativeToolRegistry — clerum__attachment_read (#666)', () => {
  it('registers the tool for a message with a kind:file attachment', () => {
    const registry = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      message(attachments('file')),
      undefined,
      undefined,
      undefined,
      attachmentOptions()
    )
    expect(toolNames(registry)).toContain('clerum__attachment_read')
    expect(registry.get('clerum__attachment_read')!.parametersSchema()).toMatchObject({
      properties: { maxBytes: { maximum: 65_536 } },
    })
  })

  it.each([
    ['no source message', undefined],
    ['no attachments', message()],
    ['only image attachments', message(attachments('image'))],
  ])('does not register the tool with %s', (_label, source) => {
    // Witness: the same config registers the tool once a file is attached.
    const control = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      message(attachments('file')),
      undefined,
      undefined,
      undefined,
      attachmentOptions()
    )
    expect(toolNames(control)).toContain('clerum__attachment_read')
    const registry = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      source,
      undefined,
      undefined,
      undefined,
      attachmentOptions()
    )
    // Witness: the registry was built and presents its always-on native tools.
    expect(toolNames(registry)).toContain('file_read')
    expect(toolNames(registry)).not.toContain('clerum__attachment_read')
  })

  it('refuses to build without the per-call limit when a file is attached', () => {
    const { attachmentTextReadMaxBytes: _omitted, ...withoutLimit } = config
    // Control: the same config builds when no file is attached.
    expect(
      () =>
        new NativeToolRegistry(
          withoutLimit,
          'conv-1',
          undefined,
          message(),
          undefined,
          undefined,
          undefined,
          attachmentOptions()
        )
    ).not.toThrow()
    expect(
      () =>
        new NativeToolRegistry(
          withoutLimit,
          'conv-1',
          undefined,
          message(attachments('file')),
          undefined,
          undefined,
          undefined,
          attachmentOptions()
        )
    ).toThrow('NativeToolConfig.attachmentTextReadMaxBytes is required for file attachments')
  })

  it('refuses to register the tool without the turn ledger and window', () => {
    // Control: the full wiring registers it.
    expect(
      () =>
        new NativeToolRegistry(
          config,
          'conv-1',
          undefined,
          message(attachments('file')),
          undefined,
          undefined,
          undefined,
          attachmentOptions()
        )
    ).not.toThrow()
    expect(
      () =>
        new NativeToolRegistry(
          config,
          'conv-1',
          undefined,
          message(attachments('file')),
          undefined,
          undefined,
          undefined,
          { maxBytes: 3_145_728 }
        )
    ).toThrow(/ledger/)
  })

  it('wires the SAME turn ledger into the registered tool', async () => {
    const ledger = new AttachmentReadLedger()
    for (let i = 0; i < 32; i++) ledger.beginRead()
    const registry = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      message(attachments('file')),
      undefined,
      undefined,
      undefined,
      attachmentOptions(ledger)
    )
    const tool = registry.get('clerum__attachment_read')!
    const output = await tool.execute({ attachmentId: 'file-1' })
    // The pre-spent ledger is observable through the registry-built tool.
    expect(output.content).toContain('read_budget_exhausted')
    expect(output.is_error).toBe(false)
  })

  it('registers a spillover-exempt tool whether or not the turn has spillover storage', () => {
    const storage = new SpilloverStorage({
      workspacePath: '/tmp',
      thresholdBytes: 8192,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    })
    const withSpillover = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      message(attachments('file')),
      undefined,
      undefined,
      undefined,
      attachmentOptions(),
      storage
    )
    // Witness: this turn can spill (the read-back tool is present).
    expect(withSpillover.get('clerum__spillover_read')).not.toBeNull()
    const spilling = withSpillover.get('clerum__attachment_read')!
    expect(spilling.spilloverExempt?.()).toBe(true)
    expect(spilling.description()).toContain('reader=text')
    expect(spilling.description()).not.toContain('spillover')

    const inline = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      message(attachments('file')),
      undefined,
      undefined,
      undefined,
      attachmentOptions()
    )
    expect(inline.get('clerum__spillover_read')).toBeNull()
    const reader = inline.get('clerum__attachment_read')!
    expect(reader.spilloverExempt?.()).toBe(true)
    expect(reader.description()).toContain('reader=text')
    expect(reader.description()).not.toContain('spillover')
  })

  // A15 item 5 — the registry must hand the turn's ConfigStore secrets to the
  // tool's whole-text redactor. The loop's per-page sanitizer sees the same
  // secrets, but only whole: a literal cut by a page end reaches the model
  // unless the tool masked it against the whole text first.
  it('masks a ConfigStore secret split across pages with the turn secretEntriesProvider', async () => {
    const TOOL = 'clerum__attachment_read'
    const configLiteral = 'CfgLiteralSecretValue9f8e7d'
    const secretEntriesProvider = () => [{ name: 'CFG_TOKEN', value: configLiteral }]
    // What the loop applies to every page: the same ConfigStore secrets.
    const loopSafety = new BasicSafety(secretEntriesProvider)
    const context = {
      onOutput: () => {},
      measureResult: (raw: string): number =>
        Math.ceil(Buffer.byteLength(loopSafety.previewOutputForLlm(TOOL, raw), 'utf8') / 4) + 4,
    }
    const before = 'intro text line\n'
    const text = before + configLiteral + '\ntrailing words here\n'
    const bytes = Buffer.from(text)
    const validated = validateIncomingAttachments(
      [
        {
          id: 'file-1',
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
      { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 3_145_728, messageId: 'message-1' }
    )
    if (!validated.ok) throw new Error(`fixture rejected: ${validated.error.code}`)
    const registry = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      message(validated.attachments!),
      undefined,
      undefined,
      undefined,
      { ...attachmentOptions(), secretEntriesProvider }
    )
    const tool = registry.get(TOOL)!

    /** One page as the model receives it: tool output, then the loop's pass. */
    const readPage = async (params: Record<string, unknown>) => {
      const output = await tool.execute(params, context)
      return {
        output,
        body: JSON.parse(output.content) as {
          kind: string
          text?: string
          truncated?: boolean
          nextOffset?: number
        },
        visible: loopSafety.sanitizeOutput(TOOL, output.content).content,
      }
    }
    /** The first 6-character piece of the secret that `visible` shows, if any. */
    const leakedPiece = (visible: string): string | null => {
      for (let i = 0; i + 6 <= configLiteral.length; i++) {
        if (visible.includes(configLiteral.slice(i, i + 6))) return configLiteral.slice(i, i + 6)
      }
      return null
    }

    // Witness: read whole, the file carries the literal and the model sees it
    // redacted. This holds with or without the provider at the registry (the
    // loop pass masks a whole literal), so only the split walk below can tell
    // whether the registry wired the provider into the tool.
    const whole = await readPage({ attachmentId: 'file-1' })
    expect(whole.body).toMatchObject({ kind: 'text', truncated: false })
    expect(whole.visible).toContain('[REDACTED')
    expect(whole.visible).toContain('intro text line')
    expect(leakedPiece(whole.visible)).toBeNull()

    // Split: the first page ends in the middle of the literal.
    const splitAt = Buffer.byteLength(before) + Math.floor(configLiteral.length / 2)
    const pages: Awaited<ReturnType<typeof readPage>>[] = []
    let offset = 0
    for (;;) {
      const page = await readPage({ attachmentId: 'file-1', offset, maxBytes: splitAt })
      expect(page.body.kind).toBe('text')
      pages.push(page)
      if (!page.body.truncated) break
      offset = page.body.nextOffset!
    }
    // Precondition: the walk really crossed the secret on a page boundary.
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]!.body.nextOffset).toBe(splitAt)
    for (const page of pages) {
      expect(leakedPiece(page.visible)).toBeNull()
    }
    // Liveness: the text around the secret is still delivered.
    const joined = pages.map(page => page.body.text).join('')
    expect(joined).toContain('intro text line')
    expect(joined).toContain('trailing words here')
  })
})
