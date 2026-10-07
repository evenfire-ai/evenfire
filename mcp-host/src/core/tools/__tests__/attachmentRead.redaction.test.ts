/**
 * jozer-rami M2 — redaction must not depend on where a page ends. The ranges
 * come from the whole decoded text, so a secret split by `maxBytes`, by the
 * budget fit or by a model-chosen `offset` is masked on both sides. What the
 * model sees is the page after the loop's own per-page `sanitizeOutput`, so
 * every assertion runs on that.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import type { IncomingMessage } from '../../../server'
import { AttachmentReadLedger } from '../../attachments/attachmentReadBudget'
import { BasicSafety } from '../../safety/safety'
import type { Attachment } from '../../types'
import { AttachmentReadTool } from '../attachmentRead'

const TOOL = 'clerum__attachment_read'
const READ_LIMIT = 65_536
const CONFIGURED = 'CfgLiteralSecretValue9f8e7d'
const safety = new BasicSafety(() => [{ name: 'CFG_TOKEN', value: CONFIGURED }])
const measureResult = (raw: string): number =>
  Math.ceil(Buffer.byteLength(safety.previewOutputForLlm(TOOL, raw), 'utf8') / 4) + 4

// Each shape: the whole string the rule matches, and the secret part of it.
const SHAPES = [
  { name: 'GitHub token', label: 'ghp_', value: 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8' },
  { name: 'Stripe key', label: 'sk_live_', value: 'Ab12Cd34Ef56Gh78Ij90Kl12' },
  { name: 'Bearer token', label: 'Bearer ', value: 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm' },
  { name: 'password value', label: 'password=', value: 'Sup3rS3cretValue123' },
  { name: 'ConfigStore literal', label: '', value: CONFIGURED },
] as const

const BEFORE = 'intro text line\n'
const AFTER = '\ntrailing words here\n'

function admitted(id: string, bytes: Buffer): Attachment {
  const result = validateIncomingAttachments(
    [
      {
        id,
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
    { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 11_534_336, messageId: 'message-1' }
  )
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  return result.attachments![0]!
}

function toolFor(attachment: Attachment, contextWindowTokens = 4_000_000): AttachmentReadTool {
  const message: IncomingMessage = {
    content: 'Analyze the attached file',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-10-07T10:00:00Z',
    messageId: 'message-1',
    hostRef: 'host-1',
    attachments: [attachment],
  }
  return new AttachmentReadTool(message, READ_LIMIT, {
    contextWindowTokens,
    ledger: new AttachmentReadLedger(),
    redactor: safety,
  })
}

/** One page as the model receives it: tool output, then the per-page pass. */
async function readPage(tool: AttachmentReadTool, params: Record<string, unknown>) {
  const output = await tool.execute(params, { onOutput: () => {}, measureResult })
  const visible = safety.sanitizeOutput(TOOL, output.content)
  return {
    body: JSON.parse(output.content) as {
      kind: string
      text?: string
      byteRange?: { offset: number; length: number }
      truncated?: boolean
      nextOffset?: number
      limit?: string
    },
    visible: visible.content,
    wasModified: visible.was_modified,
  }
}

/** Every page from `offset` to EOF, with a fixed `maxBytes`. */
async function walk(tool: AttachmentReadTool, maxBytes?: number) {
  const pages: Awaited<ReturnType<typeof readPage>>[] = []
  let offset = 0
  for (;;) {
    const page = await readPage(tool, {
      attachmentId: 'file-1',
      offset,
      ...(maxBytes ? { maxBytes } : {}),
    })
    expect(page.body.kind).toBe('text')
    pages.push(page)
    if (!page.body.truncated) return pages
    offset = page.body.nextOffset!
  }
}

/** The first `width`-character piece of `value` that `visible` shows, if any. */
function leakedPiece(visible: string, value: string, width = 6): string | null {
  for (let i = 0; i + width <= value.length; i++) {
    const piece = value.slice(i, i + width)
    if (visible.includes(piece)) return piece
  }
  return null
}

describe('attachment pages are redacted against the whole text (jozer-rami M2)', () => {
  it('refuses to register without a redactor', () => {
    const file = admitted('file-1', Buffer.from('plain text'))
    const message = { ...({} as IncomingMessage), attachments: [file] }
    expect(
      () =>
        new AttachmentReadTool(message, READ_LIMIT, {
          contextWindowTokens: 4_000_000,
          ledger: new AttachmentReadLedger(),
        } as never)
    ).toThrow(/require a redactor/)
    // Witness: the same options with a redactor construct the tool.
    expect(toolFor(file).name()).toBe(TOOL)
  })

  it.each(SHAPES)('a $name split across pages by maxBytes does not leak', async shape => {
    const secret = shape.label + shape.value
    const text = BEFORE + secret + AFTER
    const file = admitted('file-1', Buffer.from(text))

    // Witness: read whole, the same text is redacted by the rule under test.
    const whole = await walk(toolFor(file))
    expect(whole).toHaveLength(1)
    expect(whole[0]!.visible).toContain('[REDACTED')
    expect(leakedPiece(whole[0]!.visible, shape.value)).toBeNull()

    const splitAt = Buffer.byteLength(BEFORE) + Math.floor(secret.length / 2)
    const pages = await walk(toolFor(file), splitAt)
    // Precondition: the first page really ends inside the secret.
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]!.body.nextOffset).toBe(splitAt)
    for (const page of pages) {
      expect(leakedPiece(page.visible, shape.value)).toBeNull()
    }
    // Liveness: the text around the secret is still delivered.
    expect(pages.map(p => p.body.text).join('')).toContain('intro text line')
    expect(pages.map(p => p.body.text).join('')).toContain('trailing words here')
  })

  it('a page that starts in the middle of a secret leaks none of its tail', async () => {
    const shape = SHAPES[0]
    const secret = shape.label + shape.value
    const file = admitted('file-1', Buffer.from(BEFORE + secret + AFTER))
    const offset = Buffer.byteLength(BEFORE) + 10
    const page = await readPage(toolFor(file), { attachmentId: 'file-1', offset })
    expect(page.body.byteRange?.offset).toBe(offset)
    expect(page.body.text).toContain('trailing words here')
    expect(leakedPiece(page.visible, shape.value)).toBeNull()
  })

  // Regression guard: masking changes the text, never the byte accounting.
  it('pages walked to EOF still cover every byte of the file once', async () => {
    const text = BEFORE + SHAPES.map(s => s.label + s.value).join('\n') + AFTER
    const bytes = Buffer.from(text)
    const pages = await walk(toolFor(admitted('file-1', bytes)), 17)
    let expected = 0
    for (const page of pages) {
      expect(page.body.byteRange!.offset).toBe(expected)
      expected += page.body.byteRange!.length
    }
    expect(expected).toBe(bytes.length)
    expect(pages[pages.length - 1]!.body.truncated).toBe(false)
  })

  it('a split forced by the page budget does not leak the tail', async () => {
    // Dense GitHub-shaped tokens separated by single spaces: a budget-bound
    // page end almost always lands inside one. The budget measures the
    // redacted preview (each token costs about 11 bytes), so the file needs
    // well over a page of tokens.
    const tokens = Array.from(
      { length: 1_500 },
      (_, i) => 'ghp_' + createHash('sha256').update(`token-${i}`).digest('hex')
    )
    const bytes = Buffer.from(tokens.join(' '))
    const tool = toolFor(admitted('file-1', bytes), 20_000)
    const first = await readPage(tool, { attachmentId: 'file-1' })
    expect(first.body).toMatchObject({ kind: 'text', truncated: true })
    expect(first.body.limit).not.toBe('max_bytes')
    // Unmasked, the fit ended inside a token and the next page started with
    // its unredacted tail. Masked, a token costs the same however much of it
    // a page holds, so the fit ends where a token starts; the assertions
    // below hold either way, and the vacuity mutation shows the leak.
    const boundary = first.body.nextOffset!

    const second = await readPage(tool, { attachmentId: 'file-1', offset: boundary })
    expect(second.body.kind).toBe('text')
    expect(second.body.byteRange!.length).toBeGreaterThan(0)
    for (const page of [first, second]) {
      // No run of token characters long enough to be a token piece survives.
      expect(page.body.text).toBeDefined()
      expect(JSON.parse(page.visible).text).not.toMatch(/[a-zA-Z0-9]{12,}/)
    }
  })
})

describe('a private key split across attachment pages (#1034)', () => {
  // Interpolated so the repository's public-boundary scanner does not read a
  // private key header in this file.
  const LABEL = 'OPENSSH '
  const HEADER = `-----BEGIN ${LABEL}PRIVATE KEY-----`
  const FOOTER = `-----END ${LABEL}PRIVATE KEY-----`
  // Synthetic OpenSSH-width body: 70-column lines, then a short last line.
  const LINES = [0, 1, 2, 3, 4].map(n => {
    const line = [0, 1]
      .map(half => createHash('sha256').update(`key-${n}-${half}`).digest('base64'))
      .join('')
      .replace(/=/g, '')
    return line.slice(0, n === 4 ? 30 : 70)
  })
  const BODY = LINES.join('\n')
  const at = (text: string, part: string) => Buffer.byteLength(text.slice(0, text.indexOf(part)))

  /** Pages ending at each byte in `cuts`, then the rest of the file. */
  async function pagesAt(text: string, cuts: number[]) {
    const tool = toolFor(admitted('file-1', Buffer.from(text)))
    const pages: Awaited<ReturnType<typeof readPage>>[] = []
    let offset = 0
    for (const cut of [...cuts, undefined]) {
      const page = await readPage(tool, {
        attachmentId: 'file-1',
        offset,
        ...(cut === undefined ? {} : { maxBytes: cut - offset }),
      })
      expect(page.body.kind).toBe('text')
      // The page starts where the previous one ended and ends at the cut.
      expect(page.body.byteRange!.offset).toBe(offset)
      if (cut !== undefined) expect(page.body.nextOffset).toBe(cut)
      pages.push(page)
      offset = page.body.nextOffset ?? offset + page.body.byteRange!.length
    }
    expect(pages[pages.length - 1]!.body.truncated).toBe(false)
    expect(offset).toBe(Buffer.byteLength(text))
    return pages
  }

  function expectNoKeyPiece(pages: Awaited<ReturnType<typeof readPage>>[]) {
    for (const page of pages) {
      for (const line of LINES) expect(leakedPiece(page.visible, line, 8)).toBeNull()
      // Every page here holds key material, and the whole-text ranges masked
      // it before the per-page pass ran.
      expect(page.visible).toContain('[REDACTED]')
    }
  }

  it('a cut inside a body line leaks neither half', async () => {
    const text = `${BEFORE}${HEADER}\n${BODY}\n${FOOTER}${AFTER}`
    const pages = await pagesAt(text, [at(text, LINES[1]!) + 30])
    expectNoKeyPiece(pages)
    expect(pages[0]!.body.text).toContain('intro text line')
    expect(pages[1]!.body.text).toContain('trailing words here')
  })

  it('a cut right after the header leaks no body', async () => {
    const text = `${BEFORE}${HEADER}\n${BODY}\n${FOOTER}${AFTER}`
    const pages = await pagesAt(text, [at(text, HEADER) + HEADER.length])
    expectNoKeyPiece(pages)
    expect(pages[0]!.body.text).toContain('intro text line')
    expect(pages[1]!.body.text).toContain('trailing words here')
  })

  it.each([true, false])(
    'a middle page holding only body leaks nothing (footer: %s)',
    async withFooter => {
      const text = `${BEFORE}${HEADER}\n${BODY}${withFooter ? `\n${FOOTER}` : ''}${AFTER}`
      const pages = await pagesAt(text, [at(text, LINES[0]!) + 10, at(text, LINES[3]!) + 10])
      expect(pages).toHaveLength(3)
      // Precondition: the middle page holds neither marker.
      expect(pages[1]!.body.text).not.toContain('PRIVATE KEY')
      expectNoKeyPiece(pages)
      expect(pages[0]!.body.text).toContain('intro text line')
      expect(pages[2]!.body.text).toContain('trailing words here')
    }
  )

  it('a file that starts mid-key leaks none of the tail before the footer', async () => {
    const text = `${BODY.slice(20)}\n${FOOTER}${AFTER}`
    const pages = await pagesAt(text, [at(text, LINES[2]!) + 10])
    expectNoKeyPiece(pages)
    expect(pages[1]!.body.text).toContain('trailing words here')
  })
})
