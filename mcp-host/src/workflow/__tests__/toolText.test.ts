import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { cleanText, cleanToolArgs } from '../toolText'
import { XML_FORBIDDEN_CHARS, zipEntries } from './support/zipEntries'

describe('cleanText', () => {
  it('drops ANSI escapes copied from a terminal', () => {
    expect(cleanText('\u001b[31mERROR\u001b[0m done')).toBe('ERROR done')
    expect(cleanText('\u001b]0;title\u0007after')).toBe('after')
    expect(cleanText('\u001b(Bplain\u001b[0m')).toBe('plain')
    expect(cleanText('\u001b7saved\u001b8 \u001bcreset')).toBe('saved reset')
  })

  it('keeps the text after an unterminated escape', () => {
    expect(cleanText('a\u001b]0;never closed')).toBe('a0;never closed')
  })

  it('drops the control characters XML cannot carry and keeps tab and newline', () => {
    expect(cleanText('a\u0000b\u0007c\bd\te\nf')).toBe('abcd\te\nf')
  })

  it('turns form feeds and vertical tabs into line breaks instead of joining words', () => {
    expect(cleanText('Page one end\fPage two\vstart')).toBe('Page one end\nPage two\nstart')
  })

  it('turns CRLF and lone CR into LF', () => {
    expect(cleanText('# Title\r\n\r\nbody\rend')).toBe('# Title\n\nbody\nend')
  })

  it('drops half a surrogate pair but keeps whole emoji', () => {
    expect(cleanText('ok \u{1F680}')).toBe('ok \u{1F680}')
    expect(cleanText('cut \uD83D')).toBe('cut ')
  })
})

describe('cleanToolArgs', () => {
  it('cleans strings at any depth, keys included', () => {
    const cleaned = cleanToolArgs({
      body: 'a\r\nb',
      tables: [{ rows: [['\u001b[1mx\u001b[0m', 3, null, true]] }],
      columnFormats: { 'Cost\u0007': 'currency' },
    })
    expect(cleaned).toEqual({
      body: 'a\nb',
      tables: [{ rows: [['x', 3, null, true]] }],
      columnFormats: { Cost: 'currency' },
    })
  })

  it('keeps a "__proto__" key an own property instead of a prototype', () => {
    const cleaned = cleanToolArgs(JSON.parse('{"__proto__": {"polluted": true}}'))
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(cleaned, '__proto__')).toBe(true)
  })

  it('keeps the key that was already clean when another one cleans to it', () => {
    const cleaned = cleanToolArgs({ sheets: 'validated', 'sheets\u0000': 'smuggled' })
    expect(cleaned).toEqual({ sheets: 'validated' })
    const reversed = cleanToolArgs({ 'body\u0007': 'smuggled', body: 'validated' })
    expect(reversed).toEqual({ body: 'validated' })
  })

  it('keeps values nested absurdly deep as they are instead of overflowing the stack', () => {
    let deep: unknown = 'x\u0007'
    for (let i = 0; i < 10_000; i++) deep = [deep]
    const cleaned = cleanToolArgs({ body: 'a\u0007', extra: deep }) as {
      body: string
      extra: unknown
    }
    expect(cleaned.body).toBe('a')
    let inner = cleaned.extra
    for (let i = 0; i < 10_000; i++) inner = (inner as unknown[])[0]
    expect(inner).toBe('x\u0007')
  })

  it('writes a call whose unread extra argument is nested absurdly deep', async () => {
    let deep: unknown = { x: 1 }
    for (let i = 0; i < 2000; i++) deep = { n: deep }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-deep-'))
    try {
      const markdown = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_markdown')!
      const result = await markdown.execute({ filename: 'n.md', content: 'x', extra: deep }, dir)
      expect(result.success, result.error).toBe(true)
      expect(result.content).toContain("Ignored arguments this tool does not read: 'extra'")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not copy the input', () => {
    const input = { body: 'x' }
    cleanToolArgs(input)
    expect(input).toEqual({ body: 'x' })
  })
})

describe('generated Office files', () => {
  const dirty = 'build \u001b[31mFAILED\u001b[0m\f page\v two\u0000'
  let outputDir: string

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-xml-'))
  })

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  it.each([
    ['clerum__generate_docx', { filename: 'd.docx', title: dirty, body: dirty }],
    ['clerum__generate_xlsx', { filename: 'x.xlsx', sheets: [{ name: 'S', rows: [[dirty]] }] }],
    [
      'clerum__generate_pptx',
      { filename: 'p.pptx', slides: [{ layout: 'title-bullets', title: dirty, bullets: [dirty] }] },
    ],
  ])('%s never writes a character XML forbids', async (tool, args) => {
    const result = await INTERNAL_TOOLS.find(t => t.name === tool)!.execute(args, outputDir)
    expect(result.success).toBe(true)
    for (const [name, data] of zipEntries(result.artifact!.path)) {
      if (name.endsWith('.xml'))
        expect(data.toString('utf8'), name).not.toMatch(XML_FORBIDDEN_CHARS)
    }
  })
})
