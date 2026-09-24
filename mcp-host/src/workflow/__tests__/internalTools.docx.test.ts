/**
 * The DOCX generator against the documents models actually send: pasted
 * terminal output, years as table headers, loose and nested lists, HTML line
 * breaks in cells, images named in the body, and rows sent as records. Each
 * case reads the written package, not just the success flag.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { inlineRuns } from '../docxInline'
import { bodyToDocxChildren } from '../docxMarkdown'
import { DOCX_PALETTES, DocxListNumbering } from '../docxStyle'
import { INTERNAL_TOOLS } from '../internalTools'
import { StepMcpRouter } from '../stepRouter'
import type { InternalToolDefinition, InternalToolResult } from '../types'
import { XML_FORBIDDEN_CHARS, zipEntries, zipEntryText } from './support/zipEntries'

function docxTool(): InternalToolDefinition {
  return INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_docx')!
}

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-docx-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function generate(args: Record<string, unknown>): Promise<InternalToolResult> {
  return docxTool().execute({ filename: 'd.docx', ...args }, outputDir)
}

async function documentXml(args: Record<string, unknown>): Promise<string> {
  const r = await generate(args)
  expect(r.success, r.error).toBe(true)
  return zipEntryText(r.artifact!.path, 'word/document.xml')
}

function writePng(name: string, width: number, height: number): void {
  const canvas = createCanvas(width, height)
  canvas.getContext('2d').fillRect(0, 0, width, height)
  fs.writeFileSync(path.join(outputDir, name), canvas.toBuffer('image/png'))
}

/** Every drawing's extent, in pixels at 96 dpi. */
function extents(xml: string): Array<{ width: number; height: number }> {
  return [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map(m => ({
    width: Math.round(Number(m[1]) / 9525),
    height: Math.round(Number(m[2]) / 9525),
  }))
}

/** The text of every w:t in the part, in order. */
function texts(xml: string): string[] {
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1])
}

function paragraphs(xml: string): string[] {
  return xml.match(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/g) ?? []
}

const XML_REFERENCE = /^&(?:lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-f]+));/i
const START_TAG =
  /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function legalCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  )
}

function badReference(text: string): string | undefined {
  for (let at = text.indexOf('&'); at >= 0; at = text.indexOf('&', at + 1)) {
    const ref = XML_REFERENCE.exec(text.slice(at))
    const cp = ref?.[1] ? Number(ref[1]) : ref?.[2] ? parseInt(ref[2], 16) : undefined
    if (!ref || (cp !== undefined && !legalCodePoint(cp))) return `bad reference at ${at}`
  }
  return undefined
}

/**
 * Why `xml` is not a well-formed XML document, or undefined when it is: legal
 * characters and references, quoted unique attributes, and one balanced root.
 */
function wellFormed(xml: string): string | undefined {
  if (XML_FORBIDDEN_CHARS.test(xml)) return 'forbidden character'
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(xml)) {
    return 'lone surrogate'
  }
  const open: string[] = []
  let roots = 0
  let at = 0
  while (at < xml.length) {
    const lt = xml.indexOf('<', at)
    const text = xml.slice(at, lt < 0 ? xml.length : lt)
    if (open.length === 0 && text.trim() !== '') return `text outside the root at ${at}`
    const bad = badReference(text)
    if (bad) return bad
    if (lt < 0) break
    const rest = xml.slice(lt)
    const skip = ['<?', '?>', '<!--', '-->', '<![CDATA[', ']]>']
    const special = [0, 2, 4].find(k => rest.startsWith(skip[k]))
    if (special !== undefined) {
      const end = rest.indexOf(skip[special + 1])
      if (end < 0) return `unterminated ${skip[special]} at ${lt}`
      at = lt + end + skip[special + 1].length
      continue
    }
    const close = /^<\/([^\s>]+)\s*>/.exec(rest)
    if (close) {
      if (open.pop() !== close[1]) return `mismatched </${close[1]}> at ${lt}`
      at = lt + close[0].length
      continue
    }
    const tag = START_TAG.exec(rest)
    if (!tag) return `malformed tag at ${lt}`
    const names = new Set<string>()
    for (const attr of tag[2].matchAll(ATTRIBUTE)) {
      if (names.has(attr[1])) return `duplicate attribute ${attr[1]} at ${lt}`
      names.add(attr[1])
      const valueProblem = badReference(attr[2] ?? attr[3])
      if (valueProblem) return valueProblem
    }
    if (open.length === 0 && ++roots > 1) return `second root at ${lt}`
    if (!tag[3]) open.push(tag[1])
    at = lt + tag[0].length
  }
  if (open.length > 0) return `unclosed <${open[open.length - 1]}>`
  return roots === 1 ? undefined : 'no root element'
}

describe('generate_docx text that XML cannot carry', () => {
  it('has a well-formedness check that catches what Word rejects', () => {
    expect(wellFormed('<a x="1"><b/>t &amp; &#x20AC;</a>')).toBeUndefined()
    for (const broken of [
      '<a>\u0001</a>',
      '<a>&#x1;</a>',
      '<a>a & b</a>',
      '<a><b></a></b>',
      '<a x="1" x="2"/>',
      '<a/><b/>',
      '<a>',
    ]) {
      expect(wellFormed(broken), broken).toBeDefined()
    }
  })

  it('writes well-formed parts from ANSI escapes and control characters', async () => {
    const dirty = 'Build \u001b[32mOK\u001b[0m\f page\u000b two\u0007\u0000'
    const r = await generate({
      title: dirty,
      headline: dirty,
      body: `# ${dirty}\n\n\`\`\`\n${dirty}\n\`\`\`\n\n| A | B |\n|---|---|\n| ${dirty} | x |`,
      tables: [{ headers: [dirty], rows: [[dirty]] }],
      branding: { companyName: dirty, footerText: dirty },
    })
    expect(r.success, r.error).toBe(true)
    for (const [name, data] of zipEntries(r.artifact!.path)) {
      if (name.endsWith('.xml') || name.endsWith('.rels')) {
        expect(wellFormed(data.toString('utf8')), name).toBeUndefined()
      }
    }
    expect(texts(zipEntryText(r.artifact!.path, 'word/document.xml'))).toContain(
      'Build OK page two'
    )
  })

  it('reads a body with Windows line endings as markdown', async () => {
    const xml = await documentXml({
      body: '# Title\r\n\r\n### Sub\r\n\r\n```bash\r\necho hi\r\n```\r\nText',
    })
    expect(xml).not.toContain('```')
    expect(xml).not.toContain('### Sub')
    expect(xml).toContain('<w:pStyle w:val="Heading3"/>')
    expect(xml).not.toContain('\r')
  })
})

describe('generate_docx tables', () => {
  it('prints numeric headers instead of leaving the header row blank', async () => {
    const xml = await documentXml({
      body: 'x',
      tables: [{ headers: ['Region', 2024, 2025], rows: [['North', 1, 2]] }],
    })
    expect(texts(xml)).toEqual(expect.arrayContaining(['Region', '2024', '2025']))
  })

  it('reads rows sent as records by header name and says so', async () => {
    const r = await generate({
      body: 'x',
      tables: [{ headers: ['Name', 'Qty'], rows: [{ Name: 'Widget', Qty: 5 }] }],
    })
    expect(r.success, r.error).toBe(true)
    const xml = zipEntryText(r.artifact!.path, 'word/document.xml')
    expect(texts(xml)).toEqual(expect.arrayContaining(['Widget', '5']))
    expect(r.content).toMatch(/tables\[0\].*array of cells in header order/)
  })

  it('gives every column a real width', async () => {
    const xml = await documentXml({
      body: 'x',
      tables: [{ headers: ['Name', 'Description'], rows: [['a', 'a much longer description']] }],
    })
    const grid = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(m => Number(m[1]))
    expect(grid).toHaveLength(2)
    expect(Math.min(...grid)).toBeGreaterThan(700)
    expect(grid[1]).toBeGreaterThan(grid[0])
    expect(grid.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9026)
    expect(xml).toMatch(/<w:tcW w:type="dxa" w:w="\d+"\/>/)
  })

  it('fixes the layout of a wide table so Word cannot push it off the page', async () => {
    const headers = Array.from({ length: 12 }, (_, i) => `Col ${i + 1}`)
    const xml = await documentXml({ body: 'x', tables: [{ headers, rows: [headers] }] })
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>')
    const grid = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(m => Number(m[1]))
    expect(grid).toHaveLength(12)
    expect(grid.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9026)
    expect(Math.min(...grid)).toBeGreaterThan(600)
  })

  it('recognises a GFM table written without the outer pipes', async () => {
    const xml = await documentXml({ body: 'Name | Qty\n--- | ---\nWidget | 5\n\nAfter' })
    expect(xml).toContain('<w:tbl>')
    expect(texts(xml)).toEqual(expect.arrayContaining(['Name', 'Qty', 'Widget', '5', 'After']))
    expect(xml).not.toContain('--- | ---')
  })

  it('keeps an escaped pipe inside its cell', async () => {
    const xml = await documentXml({ body: '| Expr | Note |\n|---|---|\n| a \\| b | x |' })
    expect(texts(xml)).toContain('a | b')
  })

  it('ends a table at a heading or list item that contains a pipe', async () => {
    const xml = await documentXml({
      body: '| A | B |\n|---|---|\n| 1 | 2 |\n# Heading | with pipe\n- a | list item',
    })
    expect(xml.match(/<w:tr>/g)).toHaveLength(2)
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>')
    expect(xml).toContain('<w:numPr>')
  })

  it('reads a one-column table', async () => {
    const xml = await documentXml({ body: '| Name |\n|---|\n| Widget |' })
    expect(xml).toContain('<w:tbl>')
    expect(xml).not.toContain('|')
  })
})

describe('generate_docx code blocks', () => {
  it('prints the code without its fences and notes its language above it, as the PDF does', async () => {
    const xml = await documentXml({
      body: 'Run:\n\n```bash\nkubectl get pods\n```\n\n```\nplain\n```',
    })
    const printed = texts(xml)
    expect(printed).toContain('bash')
    expect(printed).toContain('kubectl get pods')
    expect(printed.join(' ')).not.toContain('```')
    expect(printed.indexOf('bash')).toBeLessThan(printed.indexOf('kubectl get pods'))
    expect(printed.filter(t => t === 'bash')).toHaveLength(1)
  })

  it('reads a fence of four backticks whole and keeps a shorter one inside it as code', async () => {
    const printed = texts(await documentXml({ body: '````markdown\n```js\nx\n```\n````\nAfter' }))
    expect(printed.slice(0, 4)).toEqual(['markdown', '```js', 'x', '```'])
    expect(printed).toContain('After')
  })
})

describe('generate_docx headings', () => {
  it('reads inline markdown in every heading level', async () => {
    const xml = await documentXml({
      body: '# **Bold** H1 with [link](https://example.com)\n## *Ital* H2 `code`\n### **Bold** H3',
    })
    expect(xml).not.toMatch(/\*\*|`|\[link\]/)
    expect(xml).toContain('<w:hyperlink')
  })

  it('keeps each heading with the paragraph that follows it', async () => {
    const xml = await documentXml({ body: '# One\n## Two\n### Three\nText' })
    const headings = paragraphs(xml).filter(p => /w:val="Heading[123]"/.test(p))
    expect(headings).toHaveLength(3)
    for (const p of headings) expect(p).toContain('<w:keepNext/>')
  })
})

describe('generate_docx lists', () => {
  function levels(xml: string): number[] {
    return [...xml.matchAll(/<w:ilvl w:val="(\d+)"\/>/g)].map(m => Number(m[1]))
  }
  function numIds(xml: string): number[] {
    return [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(m => Number(m[1]))
  }

  it('nests one level per indent step, whatever the indent width', async () => {
    const four = await documentXml({ body: '- L1\n    - L2\n        - L3\n            - L4' })
    expect(levels(four)).toEqual([0, 1, 2, 3])
    const two = await documentXml({ body: '- L1\n  - L2\n    - L3\n      - L4\n        - L5' })
    expect(levels(two)).toEqual([0, 1, 2, 3, 4])
  })

  it('defines nine levels for both list kinds', async () => {
    const r = await generate({ body: '- a\n\n1. b' })
    const numbering = zipEntryText(r.artifact!.path, 'word/numbering.xml')
    const abstracts = numbering.match(/<w:abstractNum [\s\S]*?<\/w:abstractNum>/g) ?? []
    const ours = abstracts.filter(a => /%1\.|\u2022/.test(a))
    expect(ours.length).toBeGreaterThanOrEqual(2)
    for (const a of ours) expect(a.match(/<w:lvl /g)).toHaveLength(9)
  })

  it('restarts numbering for a separate list', async () => {
    const xml = await documentXml({ body: '1. A1\n2. A2\n\nBetween\n\n1. B1\n2. B2' })
    const ids = numIds(xml)
    expect(ids).toHaveLength(4)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).toBe(ids[3])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('keeps a loose list, items apart by blank lines, as one list', async () => {
    const xml = await documentXml({ body: '1. First\n\n2. Second\n\n3. Third' })
    expect(new Set(numIds(xml)).size).toBe(1)
  })

  it('continues from the number the author wrote after a code block', async () => {
    const r = await generate({ body: '1. Run:\n\n```\nmake\n```\n\n2. Check the output' })
    const xml = zipEntryText(r.artifact!.path, 'word/document.xml')
    const second = numIds(xml)[1]
    const numbering = zipEntryText(r.artifact!.path, 'word/numbering.xml')
    const num = new RegExp(
      `<w:num w:numId="${second}"[^>]*>[\\s\\S]*?<w:startOverride w:val="(\\d+)"/>`
    ).exec(numbering)
    expect(num?.[1]).toBe('2')
  })

  it('restarts when a list starts over at 1 after a blank line', async () => {
    const xml = await documentXml({ body: '1. A1\n2. A2\n\n1. B1' })
    const ids = numIds(xml)
    expect(ids[2]).not.toBe(ids[0])
  })
})

describe('generate_docx inline HTML', () => {
  it('turns <br> into a line break, also inside a table cell', async () => {
    const xml = await documentXml({
      body: '| A | B |\n|---|---|\n| x | one<br>two |\n\nline<br/>next',
    })
    expect(xml).not.toContain('&lt;br')
    expect(xml.match(/<w:br\/>/g)?.length).toBe(2)
    expect(texts(xml)).toEqual(expect.arrayContaining(['one', 'two', 'line', 'next']))
  })

  it('renders <b> and <i>, decodes entities and drops script', async () => {
    const xml = await documentXml({
      body: 'Para with <b>bold</b>, <em>it</em> &amp; more&nbsp;x <script>alert(1)</script>',
    })
    expect(xml).not.toMatch(/&lt;\/?(b|em|script)|&amp;amp;|&amp;nbsp;|alert/)
    expect(xml).toMatch(/<w:b\/>[\s\S]*?<w:t[^>]*>bold<\/w:t>/)
    expect(xml).toMatch(/<w:i\/>[\s\S]*?<w:t[^>]*>it<\/w:t>/)
  })

  it('leaves angle-bracket placeholders and code alone', async () => {
    const xml = await documentXml({ body: 'Run kubectl -n <namespace> and `<br>` literally' })
    expect(xml).toContain('&lt;namespace&gt;')
    expect(xml).toContain('&lt;br&gt;')
  })

  it('keeps the words of block elements apart', async () => {
    const xml = await documentXml({
      body: '<p>One</p><p>Two</p>\n\n| A |\n|---|\n| <div>top</div><div>bottom</div> |\n\n<td>a</td><td>b</td>',
    })
    const all = texts(xml)
    expect(all).toEqual(expect.arrayContaining(['One', 'Two', 'top', 'bottom']))
    expect(all).not.toContain('OneTwo')
    expect(all).toContain('a b')
  })

  it('prints title and headline HTML as plain text in the page, header and properties', async () => {
    const r = await generate({
      title: '<b>Q3</b> Report',
      headline:
        '<a href="https://example.com/x">Q3</a> <code>v2</code> <i>draft</i><p>One</p><p>Two</p>',
      body: 'x',
    })
    expect(r.success, r.error).toBe(true)
    const all = [
      ...texts(zipEntryText(r.artifact!.path, 'word/document.xml')),
      ...texts(zipEntryText(r.artifact!.path, 'word/header1.xml')),
    ]
    expect(all).toContain('Q3 Report')
    expect(all).toContain('Q3 v2 draft One Two')
    expect(all.join('')).not.toMatch(/\*|`|\[|https/)
    expect(zipEntryText(r.artifact!.path, 'docProps/core.xml')).toContain(
      '<dc:title>Q3 Report</dc:title>'
    )
  })
})

describe('generate_docx images', () => {
  it('embeds an image named on its own line in the body', async () => {
    writePng('chart.png', 800, 400)
    const xml = await documentXml({ body: 'Intro\n\n![Revenue chart](chart.png)\n\nOutro' })
    expect(xml).toContain('<w:drawing>')
    expect(xml).not.toContain('![Revenue')
    expect(xml).toContain('descr="Revenue chart"')
  })

  it('embeds body images whose names hold spaces or parentheses', async () => {
    writePng('my chart.png', 80, 40)
    writePng('image (1).png', 80, 40)
    const r = await generate({ body: '![Sales](<my chart.png>)\n\n![Costs](image (1).png)' })
    expect(r.success, r.error).toBe(true)
    const xml = zipEntryText(r.artifact!.path, 'word/document.xml')
    expect(xml.match(/<w:drawing>/g)).toHaveLength(2)
    expect(r.content).not.toMatch(/not found|inside a line of text/)
  })

  it('says when the document has nothing in it', async () => {
    const empty = await generate({ body: '  ' })
    expect(empty.success, empty.error).toBe(true)
    expect(empty.content).toContain('The document is empty')
    const titled = await generate({ body: '', title: 'Report' })
    expect(titled.content).not.toContain('The document is empty')
  })

  it('leaves out a body image that does not exist, says so, and never prints its path', async () => {
    const r = await generate({ body: 'Intro\n\n![Revenue](missing.png)\n\nOutro' })
    expect(r.success, r.error).toBe(true)
    const xml = zipEntryText(r.artifact!.path, 'word/document.xml')
    expect(xml).not.toContain('missing.png')
    expect(r.content).toMatch(/missing\.png/)
  })

  it('uses the file from the output folder when the body names it by an absolute path', async () => {
    writePng('chart.png', 80, 40)
    const r = await generate({ body: '![Revenue](/output/chart.png)' })
    expect(r.success, r.error).toBe(true)
    expect(zipEntryText(r.artifact!.path, 'word/document.xml')).toContain('<w:drawing>')
    expect(r.content).toMatch(/outside the output folder/)
  })

  it('does not print an image written in the middle of a sentence', async () => {
    writePng('chart.png', 80, 40)
    const r = await generate({ body: 'See ![the chart](chart.png "Sales") here' })
    const xml = zipEntryText(r.artifact!.path, 'word/document.xml')
    expect(xml).not.toContain('chart.png')
    expect(texts(xml).join('')).toContain('the chart')
    expect(r.content).toMatch(/'chart\.png' was inside a line of text.*line of its own/)
  })

  it('accepts an image given as a bare file name', async () => {
    writePng('chart.png', 800, 400)
    const xml = await documentXml({ body: 'x', images: ['chart.png'] })
    expect(xml).toContain('<w:drawing>')
  })

  it('reports an image or a logo that is missing', async () => {
    const r = await generate({
      title: 'T',
      body: 'x',
      images: [{ path: 'nope.png' }],
      branding: { logoPath: 'logo.png' },
    })
    expect(r.success, r.error).toBe(true)
    expect(r.content).toMatch(/nope\.png/)
    expect(r.content).toMatch(/logo\.png/)
  })

  it('fails when the only thing asked for was images and none could be embedded', async () => {
    const r = await generate({ body: '', images: [{ path: 'nope.png' }] })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/nope\.png/)
  })

  it('keeps an explicit size inside the page', async () => {
    writePng('wide.png', 200, 100)
    writePng('tall.png', 200, 3000)
    const xml = await documentXml({
      body: 'x',
      images: [
        { path: 'wide.png', width: 2000 },
        { path: 'tall.png', width: 560 },
      ],
    })
    const [wide, tall] = extents(xml)
    expect(wide.width).toBeLessThanOrEqual(602)
    expect(wide.width / wide.height).toBeCloseTo(2, 1)
    expect(tall.height).toBeLessThanOrEqual(900)
    expect(tall.height / tall.width).toBeCloseTo(15, 0)
  })

  it('keeps the proportions of a square logo', async () => {
    writePng('logo.png', 300, 300)
    const xml = await documentXml({ title: 'T', body: 'x', branding: { logoPath: 'logo.png' } })
    const [logo] = extents(xml)
    expect(logo.width).toBe(logo.height)
  })

  it('draws the logo when the document has no title', async () => {
    writePng('logo.png', 300, 100)
    const xml = await documentXml({ body: 'x', branding: { logoPath: 'logo.png' } })
    expect(extents(xml)).toHaveLength(1)
  })

  it('converts a GIF or WebP to PNG and leaves out what is not an image', async () => {
    const gif = Buffer.from(
      'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
      'base64'
    )
    fs.writeFileSync(path.join(outputDir, 'dot.gif'), gif)
    const canvas = createCanvas(40, 20)
    canvas.getContext('2d').fillRect(0, 0, 40, 20)
    fs.writeFileSync(path.join(outputDir, 'pic.webp'), await canvas.encode('webp'))
    fs.writeFileSync(path.join(outputDir, 'fake.png'), 'this is not an image')
    const r = await generate({
      body: 'x',
      images: [{ path: 'dot.gif' }, { path: 'pic.webp' }, { path: 'fake.png' }],
    })
    expect(r.success, r.error).toBe(true)
    const media = [...zipEntries(r.artifact!.path)].filter(([n]) => /^word\/media\/./.test(n))
    expect(media).toHaveLength(2)
    for (const [, data] of media) expect(data.readUInt32BE(0)).toBe(0x89504e47)
    expect(r.content).toMatch(/fake\.png/)
  })

  it('still refuses an image path that escapes the output folder', async () => {
    const r = await generate({ body: '![x](../../etc/passwd)' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/path traversal blocked/)
  })

  it('names the argument and the fix when an image path leaves the output folder', async () => {
    const r = await generate({ body: 'x', images: ['chart.png', '/output/missing.png'] })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/path traversal blocked/)
    expect(r.error).toMatch(/^images\[1\]: /)
    expect(r.error).toMatch(/clerum__generate_chart/)
  })

  it('does not point at images when what failed was a table', async () => {
    const r = await generate({ body: '', tables: [{ rows: [[1]] }] })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/tables\[0\] has no headers/)
    expect(r.error).not.toMatch(/image|clerum__generate_chart/i)
  })
})

describe('generate_docx schema', () => {
  function router(): StepMcpRouter {
    const r = new StepMcpRouter(() => {
      throw new Error('factory not used')
    })
    r.registerInternalTools(INTERNAL_TOOLS, outputDir)
    return r
  }

  it('lets the workflow path send numeric headers and bare image names', async () => {
    writePng('chart.png', 80, 40)
    const { result } = await router().callTool('clerum__generate_docx', {
      filename: 'w.docx',
      body: 'x',
      images: ['chart.png', { path: 'chart.png', width: 200 }],
      tables: [{ headers: ['Region', 2024], rows: [['North', 1]] }],
    })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  })

  it('reads rows sent as records by header name, and says so', async () => {
    const { result } = await router().callTool('clerum__generate_docx', {
      filename: 'w.docx',
      body: 'x',
      tables: [{ headers: ['A'], rows: [{ A: 1 }] }],
    })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('were objects and were read by header name')
  })

  it('rejects a row that is neither an array nor a record, naming the field', async () => {
    const { result } = await router().callTool('clerum__generate_docx', {
      filename: 'w.docx',
      body: 'x',
      tables: [{ headers: ['A'], rows: ['A1'] }],
    })
    expect(result.isError).toBe(true)
    expect((result.content as { error: string }).error).toContain('tables/0/rows/0')
  })

  it('describes image paths as the file names generate_chart returns', () => {
    const text = JSON.stringify(docxTool().parameters)
    expect(text).not.toMatch(/Absolute path/i)
    expect(text).toMatch(/clerum__generate_chart/)
  })
})

describe('generate_docx on pathological text', () => {
  const LENGTH = 100_000
  const ctx = () => ({
    palette: DOCX_PALETTES.default,
    numbering: new DocxListNumbering(),
    warnings: [] as string[],
    image: () => undefined,
  })
  const repeat = (unit: string) => unit.repeat(Math.ceil(LENGTH / unit.length))

  // A pattern that rescans the line takes seconds to minutes on each of these
  // 100 KB lines, and the host serves every chat from one thread.
  it.each([
    ['unclosed images', repeat('![a](b ')],
    ['unclosed images without spaces', repeat('![a](b')],
    ['image openers', repeat('![')],
    ['brackets', repeat('[')],
    ['unclosed links', repeat('[a](http://x')],
    ['unclosed script tags', repeat('<script')],
    ['anchors without a closing tag', repeat('<a href="http://x">y')],
  ])(
    'reads a line of %s in linear time',
    (_name, line) => {
      const started = Date.now()
      inlineRuns(line, {}, [])
      expect(Date.now() - started).toBeLessThan(5000)
    },
    30_000
  )

  it.each([
    ['a separator padded with spaces', 'a | b\n' + repeat(' ') + 'x'],
    ['a separator with trailing spaces', 'a | b\n|---|---' + repeat(' ') + 'x'],
    ['a heading of spaces', '# a' + repeat(' ') + 'b'],
  ])(
    'reads a body with %s in linear time',
    (_name, body) => {
      const started = Date.now()
      bodyToDocxChildren(body, ctx())
      expect(Date.now() - started).toBeLessThan(5000)
    },
    30_000
  )
})

describe('rows with more cells than headers', () => {
  it('says the extra cells were left out', async () => {
    const r = await generate({
      body: 'x',
      tables: [{ headers: ['A', 'B'], rows: [['a', 'b', 'EXTRA']] }],
    })
    expect(r.success).toBe(true)
    expect(r.content).toContain('more cells than its 2 headers; the extra cells were left out')
  })
})
