/**
 * What the PDF generator puts on the page, read back from the file. Each case
 * checks content a success flag alone would not show was lost or mangled: rows
 * and columns dropped by the table layout, headings stranded at a page foot,
 * list numbers restarting, images skipped without a word, and markup printed
 * literally.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { StepMcpRouter } from '../stepRouter'
import type { InternalToolResult } from '../types'
import { type PdfPage, allText, readPdf } from './support/pdfText'

const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pdf')!

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-pdf-layout-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function render(
  args: Record<string, unknown>
): Promise<{ result: InternalToolResult; pages: PdfPage[] }> {
  const result = await tool.execute(args, outputDir)
  expect(result.success, result.error).toBe(true)
  return { result, pages: await readPdf(path.join(outputDir, result.artifact!.name)) }
}

/** Every fragment whose right edge passes the page's right margin. */
function pastMargin(pages: PdfPage[]): string[] {
  return pages.flatMap(p => p.fragments.filter(f => f.x1 > p.width - 39).map(f => f.text))
}

function pageOf(pages: PdfPage[], text: string): number {
  return pages.findIndex(p => p.fragments.some(f => f.text.includes(text)))
}

/** A solid PNG of the given pixel size in the output folder. */
function writePng(name: string, width: number, height: number): void {
  const canvas = createCanvas(width, height)
  canvas.getContext('2d').fillRect(0, 0, width, height)
  fs.writeFileSync(path.join(outputDir, name), canvas.toBuffer('image/png'))
}

const words = (n: number) => 'alpha beta gamma delta epsilon '.repeat(n)

describe('PDF tables keep every row and column', () => {
  it('splits a first row taller than a page instead of dropping it with the header', async () => {
    const { pages } = await render({
      filename: 't.pdf',
      body: `| Item | Description | Owner |\n|---|---|---|\n| ROWA | ${words(200)}DESCEND | Ana |\n| ROWB | short | Luis |`,
    })
    const text = allText(pages)
    for (const marker of ['Description', 'ROWA', 'DESCEND', 'ROWB']) expect(text).toContain(marker)
  })

  it('splits a middle row taller than a page', async () => {
    const { pages } = await render({
      filename: 't.pdf',
      body: 'x',
      tables: [
        {
          headers: ['Item', 'Description'],
          rows: [
            ['ROW1', 'a'],
            ['ROW2', `${words(240)}MIDEND`],
            ['ROW3', 'c'],
          ],
        },
      ],
    })
    const text = allText(pages)
    for (const marker of ['ROW1', 'ROW2', 'MIDEND', 'ROW3']) expect(text).toContain(marker)
  })

  it('fits a thirteen-column table on the page, turning it to landscape', async () => {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]
    const { result, pages } = await render({
      filename: 'wide.pdf',
      body: 'x',
      tables: [
        {
          headers: ['Metric', ...months],
          rows: [
            ['Revenue (USD)', ...months.slice(1).map((_, i) => `$1,234,${567 + i}`), 'DECVAL'],
          ],
        },
      ],
    })
    expect(allText(pages)).toContain('DECVAL')
    expect(pastMargin(pages)).toEqual([])
    const landscape = pages.find(p => p.width > p.height)
    expect(landscape?.text).toContain('Dec')
    expect(result.content).toMatch(/tables\[0\].*landscape/)
  })

  it('turns to landscape without leaving a blank page, taking the heading along', async () => {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]
    const table =
      `| Metric | ${months.join(' | ')} |\n|---|${'---|'.repeat(12)}\n` +
      `| Revenue | ${months.map((_, i) => `$1,234,${i}00`).join(' | ')} |`
    const covered = await render({
      filename: 'c.pdf',
      title: 'Cover',
      coverPage: true,
      body: `## Monthly\n\n${table}\n\nAfter the table.`,
    })
    expect(covered.pages.map(p => p.width > p.height)).toEqual([false, true, false])
    expect(pageOf(covered.pages, 'Monthly')).toBe(1)
    const first = await render({ filename: 'f.pdf', body: `${table}\n\nAfter.` })
    expect(first.pages.map(p => p.width > p.height)).toEqual([true, false])
  })

  it('breaks a long URL inside its cell rather than pushing columns off the page', async () => {
    const { pages } = await render({
      filename: 'url.pdf',
      body: 'x',
      tables: [
        {
          headers: ['Name', 'Link', 'Status'],
          rows: [['a', `https://example.com/${'x'.repeat(400)}TOKENEND`, 'LASTCOL']],
        },
      ],
    })
    expect(allText(pages)).toContain('LASTCOL')
    // Broken across lines, the URL still reads in order once the breaks are removed.
    expect(allText(pages).replace(/\s+/g, '')).toContain(`example.com/${'x'.repeat(400)}TOKENEND`)
    expect(pastMargin(pages)).toEqual([])
  })

  it('honours tables[].widths', async () => {
    const { pages } = await render({
      filename: 'w.pdf',
      body: 'x',
      tables: [{ headers: ['Narrow', 'Wide'], rows: [['a', 'b']], widths: [60, '*'] }],
    })
    const narrow = pages[0].fragments.find(f => f.text === 'Narrow')!
    const wide = pages[0].fragments.find(f => f.text === 'Wide')!
    // 60pt of column plus the 8pt of cell padding between the two texts.
    expect(wide.x0 - narrow.x0).toBeCloseTo(68, 0)
  })

  it('reports widths it cannot use', async () => {
    const { result } = await render({
      filename: 'w.pdf',
      body: 'x',
      tables: [
        { headers: ['A', 'B'], rows: [['1', '2']], widths: [60] },
        { headers: ['A', 'B'], rows: [['1', '2']], widths: [900, 900] },
      ],
    })
    expect(result.content).toMatch(/tables\[0\]\.widths has 1 entries for 2 columns/)
    expect(result.content).toMatch(/tables\[1\]\.widths add up to 1800 pt/)
  })

  it('reads rows sent as records by header name and says so', async () => {
    const { result, pages } = await render({
      filename: 'o.pdf',
      body: 'x',
      tables: [{ headers: ['Name', 'Qty'], rows: [{ Name: 'OBJNAME', Qty: 7 }] }],
    })
    expect(allText(pages)).toContain('OBJNAME')
    expect(result.content).toMatch(/tables\[0\]: 1 row\(s\) were objects/)
  })

  it('says which rows have more cells than headers', async () => {
    const { result } = await render({
      filename: 'x.pdf',
      body: '| A | B |\n|---|---|\n| a | b | EXTRABODY |',
      tables: [
        {
          headers: ['A', 'B'],
          rows: [
            ['a', 'b'],
            ['a', 'b', 'EXTRACELL'],
          ],
        },
      ],
    })
    expect(result.content).toMatch(/The body's table 1, row 1 has 3 cells for 2 headers/)
    expect(result.content).toMatch(/tables\[0\]\.rows\[1\] has 3 cells for 2 headers/)
  })

  it('names record keys that match no header', async () => {
    const { result } = await render({
      filename: 'o.pdf',
      body: 'x',
      tables: [{ headers: ['Name', 'Qty'], rows: [{ Nombre: 'RECNAME', Qty: 1 }] }],
    })
    expect(result.content).toMatch(/tables\[0\].*'Nombre'.*no header/)
  })

  it('prints numeric, boolean and empty cells and numeric headers', async () => {
    const { pages } = await render({
      filename: 'n.pdf',
      body: 'x',
      tables: [
        {
          headers: ['Region', 2026],
          rows: [
            ['North', 1250000],
            ['South', null],
            ['X', true],
          ],
        },
      ],
    })
    const text = allText(pages)
    for (const marker of ['2026', '1250000', 'South', 'true']) expect(text).toContain(marker)
  })

  it('recognises a GFM table written without the outer pipes', async () => {
    const { pages } = await render({
      filename: 'g.pdf',
      body: 'Name | Qty\n--- | ---\nNOLEAD1 | 5',
    })
    expect(allText(pages)).not.toContain('---')
    const header = pages[0].fragments.find(f => f.text === 'Name')!
    // Header cells are set in the bold face.
    expect(header.font).not.toBe(pages[0].fragments.find(f => f.text === 'NOLEAD1')!.font)
  })

  it('reads a one-column GFM table and leaves spaced asterisks alone', async () => {
    const { pages } = await render({
      filename: 'g.pdf',
      body: '| Only |\n|---|\n| ONECELL |\n\nSpaced a * b * c here',
    })
    const text = allText(pages)
    expect(text).not.toContain('|')
    const header = pages[0].fragments.find(f => f.text === 'Only')!
    expect(header.font).not.toBe(pages[0].fragments.find(f => f.text === 'ONECELL')!.font)
    expect(text).toMatch(/a\s+\*\s+b\s+\*\s+c/)
  })
})

describe('PDF body text', () => {
  it('breaks a code line with no spaces inside the page', async () => {
    const { pages } = await render({
      filename: 'c.pdf',
      body: `\`\`\`\n${'Z'.repeat(300)}CODEEND\n\`\`\``,
    })
    expect(allText(pages)).toContain('CODEEND')
    expect(pastMargin(pages)).toEqual([])
  })

  it('keeps the paragraphs of a quote apart and runs its other lines on', async () => {
    const { pages } = await render({
      filename: 'q.pdf',
      body: 'Body text.\n\n> First line\n> runs on.\n>\n> Second paragraph.',
    })
    const at = (word: string) => pages[0].fragments.find(f => f.text.includes(word))!
    expect(at('runs').y).toBeCloseTo(at('First').y, 0)
    expect(at('Second').y).toBeGreaterThan(at('First').y + 10)
    expect(at('Second').x0).toBeCloseTo(at('First').x0, 0)
    expect(at('Second').font).toBe(at('First').font)
    expect(at('First').font).not.toBe(at('Body').font)
  })

  it('sets code in a fixed-width face', async () => {
    const { pages } = await render({ filename: 'm.pdf', body: '```\niiiiiiiiii\nWWWWWWWWWW\n```' })
    const narrow = pages[0].fragments.find(f => f.text === 'iiiiiiiiii')!
    const wide = pages[0].fragments.find(f => f.text === 'WWWWWWWWWW')!
    expect(wide.x1 - wide.x0).toBeCloseTo(narrow.x1 - narrow.x0, 1)
  })

  it('keeps accented letters in the code face and code lines apart', async () => {
    const { pages } = await render({
      filename: 'm.pdf',
      body: '```\niiiiiiiiii\ncafé ñandú\n```',
    })
    const ascii = pages[0].fragments.find(f => f.text === 'iiiiiiiiii')!
    const accented = pages[0].fragments.filter(f => f.y > ascii.y + 1 && f.y < ascii.y + 30)
    expect(accented.map(f => f.text.trim())).toEqual(['café', 'ñandú'])
    for (const f of accented) expect(f.font).toBe(ascii.font)
    expect(accented[0].y - ascii.y).toBeGreaterThan(11)
  })

  it('moves a heading left at the foot of a page to the page its text starts on', async () => {
    const filler = Array.from({ length: 31 }, (_, i) => `Filler line ${i}`).join('\n')
    const { pages } = await render({
      filename: 'h.pdf',
      body: `${filler}\n## ORPHAN HEADING\n### ORPHAN SUB\nFirst paragraph AFTERHEAD.`,
    })
    const after = pageOf(pages, 'AFTERHEAD')
    expect(pageOf(pages, 'HEADING')).toBe(after)
    expect(pageOf(pages, 'SUB')).toBe(after)
  })

  it('keeps a heading on the page where the table under it starts', async () => {
    for (let n = 26; n <= 36; n++) {
      const filler = Array.from({ length: n }, (_, i) => `Filler line ${i}`).join('\n')
      const { pages } = await render({
        filename: `t${n}.pdf`,
        body: `${filler}\n## TBLHEAD\n\n| A | B |\n|---|---|\n| TROW1 | x |\n| TROW2 | y |`,
      })
      expect(pageOf(pages, 'TBLHEAD'), `${n} filler lines`).toBe(pageOf(pages, 'TROW1'))
      for (const page of pages)
        expect(page.fragments.length, `${n} filler lines`).toBeGreaterThan(0)
    }
  })

  it('does not add a page for a heading that ends the document', async () => {
    const { pages } = await render({ filename: 'h.pdf', body: '# Only a heading' })
    expect(pages).toHaveLength(1)
  })

  it('keeps numbering across blank lines and after a code block', async () => {
    const loose = await render({ filename: 'l.pdf', body: '1. First\n\n2. Second\n\n3. Third' })
    expect(loose.pages[0].text).toMatch(/1\..*2\..*3\./)
    const fenced = await render({
      filename: 'f.pdf',
      body: '1. Run:\n\n```\nnpm test\n```\n\n2. Next\n3. Last',
    })
    expect(fenced.pages[0].text).toMatch(/1\..*2\..*3\./)
    expect(fenced.pages[0].text).not.toMatch(/1\..*1\./)
  })

  it('reads a fence of four backticks whole and keeps a shorter one inside it as code', async () => {
    const { pages } = await render({
      filename: 'q.pdf',
      body: '````markdown\n```js\nx\n```\n````\nAfter',
    })
    const text = allText(pages)
    expect(text).toContain('markdown')
    expect(text).not.toContain('`markdown')
    expect(text).toMatch(/```js.*x.*```.*After/s)
  })

  it('reads the HTML tags and entities models write', async () => {
    const { pages } = await render({
      filename: 'h.pdf',
      body: 'Para with <b>bold</b> and line<br>break &amp; &lt;tag&gt; <script>alert(1)</script>\n\n| A | B |\n|---|---|\n| x | one<br>two |',
    })
    const text = allText(pages)
    expect(text).not.toMatch(/<br>|<b>|&amp;|alert/)
    expect(text).toContain('&')
    expect(text).toContain('<tag>')
    const bold = pages[0].fragments.find(f => f.text === 'bold')!
    const para = pages[0].fragments.find(f => f.text.startsWith('Para'))!
    expect(bold.font).not.toBe(para.font)
    // The <br> in the cell is a line break: 'two' sits below 'one'.
    const one = pages[0].fragments.find(f => f.text === 'one')!
    const two = pages[0].fragments.find(f => f.text === 'two')!
    expect(two.y).toBeGreaterThan(one.y)
  })

  it('writes status emoji as text instead of leaving the cell empty', async () => {
    const { pages } = await render({
      filename: 'e.pdf',
      body: '| Check | Result |\n|---|---|\n| A | ✅ |\n| B | ❌ |\n| C | 🟢 |',
    })
    const text = allText(pages)
    for (const marker of ['OK', 'X', '(green)']) expect(text).toContain(marker)
  })

  it('sets the title with the same fonts as the body', async () => {
    const { pages } = await render({ filename: 't.pdf', title: 'T1 → ✓ ≥', body: 'B1 → ✓ ≥' })
    const line = (prefix: string) =>
      pages[0].fragments
        .filter(f => Math.abs(f.y - pages[0].fragments.find(g => g.text.startsWith(prefix))!.y) < 1)
        .map(f => f.text)
        .join(' ')
        .replace(prefix, '')
    expect(line('T1')).toBe(line('B1'))
  })

  it('reports characters no face can draw instead of dropping them silently', async () => {
    const { result } = await render({ filename: 'u.pdf', body: 'Launch 🚀 day' })
    expect(result.content).toMatch(/U\+1F680/)
    expect(result.content).toMatch(/clerum__generate_docx/)
  })

  it('removes control characters and reads CRLF bodies as markdown', async () => {
    const { pages } = await render({
      filename: 'k.pdf',
      body: '# CRLF Heading\r\nESC[\u001b[31mred\u001b[0m] BEL[\u0007]\r\n```\r\necho hi\r\n```',
    })
    const text = allText(pages)
    expect(text).not.toMatch(/#|```|[\u0000-\u0008\u001b]/)
    expect(text).toContain('ESC[red]')
  })
})

describe('PDF cover, header and footer', () => {
  it('draws the cover without a title, using the headline', async () => {
    const { result, pages } = await render({
      filename: 'c.pdf',
      coverPage: true,
      headline: 'COVERHEADLINE',
      statusColor: 'red',
      body: 'x',
    })
    expect(pages[0].text).toContain('COVERHEADLINE')
    expect(pageOf(pages, 'x')).toBe(1)
    expect(result.content).toMatch(/coverPage was set without a title/)
  })

  it('says when cover-only options are given without a cover', async () => {
    const { result } = await render({ filename: 'c.pdf', headline: 'H', body: 'x' })
    expect(result.content).toMatch(
      /headline is only drawn on the cover page, so it was left out; pass coverPage: true to show it\./
    )
  })

  it('sets a long title and company name in one header line, and says the name was cut', async () => {
    const title = 'Quarterly operating review of the region '.repeat(4).trim()
    const { result, pages } = await render({
      filename: 'h.pdf',
      title,
      body: words(400),
      branding: { companyName: 'Acme Holdings International '.repeat(4).trim() },
    })
    const header = pages[1].fragments.filter(f => f.y < 50)
    expect(new Set(header.map(f => Math.round(f.y))).size).toBe(1)
    expect(header.map(f => f.text).join(' ')).toMatch(/…/)
    expect(result.content).toContain('branding.companyName is longer than the page header')
    expect(pages[0].text.replace(/\s+/g, ' ')).toContain(title)
  })

  it('keeps a footer with a long URL clear of the body', async () => {
    const url =
      'https://intranet.example.com/policies/data-classification/' +
      'confidential-information-handling-guidelines-2026-edition'
    const { pages } = await render({
      filename: 'u.pdf',
      body: words(400),
      branding: { footerText: `Confidential, see ${url} for handling rules` },
    })
    const page = pages[0]
    const isBody = (text: string) => /^(alpha|beta|gamma|delta|epsilon) ?$/.test(text)
    const body = page.fragments.filter(f => isBody(f.text))
    const footer = page.fragments.filter(f => !isBody(f.text) && f.y > page.height / 2)
    // The URL takes two of the footer's lines, all of them below the body.
    expect(new Set(footer.map(f => Math.round(f.y))).size).toBeGreaterThanOrEqual(3)
    expect(Math.max(...body.map(f => f.y))).toBeLessThan(Math.min(...footer.map(f => f.y)) - 9)
  })

  it('keeps a long footer inside the page and reports what it cut', async () => {
    const footerText = Array.from({ length: 8 }, (_, i) => `FOOTLINE${i}`).join('\n')
    const { result, pages } = await render({
      filename: 'f.pdf',
      body: 'x',
      branding: { footerText },
    })
    for (let i = 0; i < 6; i++) expect(pages[0].text).toContain(`FOOTLINE${i}`)
    for (const f of pages[0].fragments) expect(f.y).toBeLessThan(pages[0].height)
    expect(result.content).toMatch(/footerText takes more than 6 lines, the most that fit/)
  })
})

describe('PDF images', () => {
  it('embeds an image given as a bare file name', async () => {
    writePng('chart.png', 400, 200)
    const { pages } = await render({ filename: 'i.pdf', body: 'x', images: ['chart.png'] })
    expect(pages[0].images).toHaveLength(1)
  })

  it('embeds body images whose names hold spaces or parentheses', async () => {
    writePng('my chart.png', 400, 200)
    writePng('image (1).png', 400, 200)
    const { result, pages } = await render({
      filename: 'i.pdf',
      body: 'Text\n\n![Sales](<my chart.png>)\n\n![Costs](image (1).png)',
    })
    expect(pages.flatMap(p => p.images)).toHaveLength(2)
    expect(result.content).not.toMatch(/not found/)
  })

  it('converts GIF and SVG images instead of failing the document', async () => {
    writePng('dot.png', 40, 40)
    fs.copyFileSync(path.join(outputDir, 'dot.png'), path.join(outputDir, 'dot.gif'))
    fs.writeFileSync(
      path.join(outputDir, 'v.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50"/></svg>'
    )
    const { pages } = await render({
      filename: 'i.pdf',
      body: 'x',
      images: ['dot.gif', { path: 'v.svg' }],
    })
    expect(pages.flatMap(p => p.images)).toHaveLength(2)
  })

  it('says when the document has nothing in it', async () => {
    const { result } = await render({ filename: 'e.pdf', body: '' })
    expect(result.content).toContain('The document is empty')
    const titled = await render({ filename: 't.pdf', body: '', title: 'Report' })
    expect(titled.result.content).not.toContain('The document is empty')
  })

  it('reports missing and unreadable images', async () => {
    fs.writeFileSync(path.join(outputDir, 'fake.png'), 'not an image')
    const { result } = await render({
      filename: 'i.pdf',
      body: 'x',
      images: [{ path: 'nope.png' }, { path: 'fake.png' }],
    })
    expect(result.content).toMatch(/'nope.png' was not found/)
    expect(result.content).toMatch(/'fake.png' is not an image/)
  })

  it('fails with a reason when no requested image could be placed and nothing else was asked for', async () => {
    const result = await tool.execute(
      { filename: 'i.pdf', body: '', images: ['nope.png'] },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/nope.png/)
  })

  it('fails with a reason when the body is only images that could not be placed', async () => {
    const result = await tool.execute({ filename: 'i.pdf', body: '![c](missing.png)' }, outputDir)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/missing.png/)
  })

  it('keeps an explicitly sized image inside the page', async () => {
    writePng('tall.png', 200, 3000)
    const { pages } = await render({
      filename: 'i.pdf',
      body: 'x',
      images: [
        { path: 'tall.png', width: 515 },
        { path: 'tall.png', height: 2000 },
      ],
    })
    const boxes = pages.flatMap(p => p.images)
    expect(boxes).toHaveLength(2)
    for (const box of boxes) {
      expect(box.x1).toBeLessThanOrEqual(555.5)
      expect(box.y1).toBeLessThanOrEqual(842 - 60 + 0.5)
    }
  })

  it('keeps a sized image above a footer of several lines', async () => {
    writePng('tall.png', 200, 3000)
    const footerText = Array.from({ length: 6 }, (_, i) => `FOOTLINE${i}`).join('\n')
    const { pages } = await render({
      filename: 'i.pdf',
      body: 'x',
      images: [{ path: 'tall.png', height: 2000 }],
      branding: { footerText },
    })
    expect(pages).toHaveLength(2)
    const [box] = pages[1].images
    const footerTop = Math.min(
      ...pages[1].fragments.filter(f => f.text.startsWith('FOOTLINE')).map(f => f.y)
    )
    expect(box.y1).toBeLessThan(footerTop - 9)
  })

  it('fits a tall logo into the cover', async () => {
    writePng('logo.png', 300, 3000)
    const { pages } = await render({
      filename: 'l.pdf',
      title: 'T',
      coverPage: true,
      body: 'x',
      branding: { logoPath: 'logo.png' },
    })
    const [logo] = pages[0].images
    expect(logo.y1 - logo.y0).toBeLessThanOrEqual(80.5)
    expect(pages[0].text).toContain('T')
  })

  it('reports a missing logo', async () => {
    const { result } = await render({
      filename: 'l.pdf',
      title: 'T',
      coverPage: true,
      body: 'x',
      branding: { logoPath: 'nologo.png' },
    })
    expect(result.content).toMatch(/'nologo.png' was not found/)
  })

  it('places a markdown image where the body puts it', async () => {
    writePng('sales.png', 400, 200)
    const { pages } = await render({
      filename: 'm.pdf',
      body: 'Intro\n\n![Revenue](sales.png)\n\nOutro',
    })
    expect(allText(pages)).not.toContain('![')
    const [image] = pages[0].images
    const intro = pages[0].fragments.find(f => f.text === 'Intro')!
    const outro = pages[0].fragments.find(f => f.text === 'Outro')!
    expect(image.y0).toBeGreaterThan(intro.y)
    expect(image.y1).toBeLessThan(outro.y)
  })

  it('leaves out a missing markdown image without printing its path', async () => {
    const { result, pages } = await render({
      filename: 'm.pdf',
      body: 'Intro\n\n![Revenue](missing.png)',
    })
    expect(allText(pages)).not.toContain('missing.png')
    expect(result.content).toMatch(/'missing.png' was not found/)
  })

  it('uses the output-folder file for an absolute path from another mode', async () => {
    writePng('chart.png', 400, 200)
    const { result, pages } = await render({
      filename: 'a.pdf',
      body: 'x',
      images: ['/output/chart.png'],
    })
    expect(pages[0].images).toHaveLength(1)
    expect(result.content).toMatch(/outside the output folder/)
  })

  it('still refuses a path outside the output folder, saying what to pass', async () => {
    const result = await tool.execute({ filename: 'a.pdf', body: '![x](/etc/hosts)' }, outputDir)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/path traversal blocked/)
    expect(result.error).toMatch(/file name/)
  })
})

describe('PDF arguments on the workflow path', () => {
  function router(): StepMcpRouter {
    const r = new StepMcpRouter(() => {
      throw new Error('factory should not be called')
    })
    r.registerInternalTools(INTERNAL_TOOLS, outputDir)
    return r
  }

  it('accepts numeric, null and boolean cells, numeric headers and widths', async () => {
    const { result } = await router().callTool('clerum__generate_pdf', {
      filename: 'n.pdf',
      body: 'x',
      tables: [
        {
          headers: ['Region', 2026],
          rows: [
            ['North', 1250000],
            ['South', null],
            ['X', true],
          ],
          widths: [120, '*'],
        },
      ],
    })
    expect(result.isError).toBeFalsy()
  })

  it('accepts images given as file names', async () => {
    writePng('chart.png', 40, 40)
    const { result } = await router().callTool('clerum__generate_pdf', {
      filename: 'i.pdf',
      body: 'x',
      images: ['chart.png', { path: 'chart.png', width: 100 }],
    })
    expect(result.isError).toBeFalsy()
  })

  it('rejects rows sent as records with the path of the row to fix', async () => {
    const { result } = await router().callTool('clerum__generate_pdf', {
      filename: 'o.pdf',
      body: 'x',
      tables: [{ headers: ['Name'], rows: [{ Name: 'a' }] }],
    })
    expect(result.isError).toBe(true)
    expect((result.content as { error?: string }).error).toMatch(/tables\/0\/rows\/0 must be array/)
  })
})

describe('PDF input that would stall the host', () => {
  // One call runs on the event loop every chat of the Host shares. The budget
  // is loose, so a slow machine passes; a quadratic layout of these takes minutes.
  const budgetMs = 20_000

  it('lays out a long token without spaces, in the body and in a table cell', async () => {
    const token = 'A'.repeat(20000)
    const started = performance.now()
    const { pages } = await render({
      filename: 'token.pdf',
      body: `data: ${token}`,
      tables: [{ headers: ['k', 'v'], rows: [['a', 'B'.repeat(20000)]] }],
    })
    expect(performance.now() - started).toBeLessThan(budgetMs)
    // The token runs over several pages, between their page numbers.
    const text = allText(pages)
    expect(text.match(/A/g)).toHaveLength(20000)
    expect(text.match(/B/g)).toHaveLength(20000)
    expect(pastMargin(pages)).toEqual([])
  }, 60_000)

  it('lays out a long run of words joined by no-break spaces', async () => {
    const started = performance.now()
    const { pages } = await render({ filename: 'nb.pdf', body: 'a\u00a0'.repeat(20_000) })
    expect(performance.now() - started).toBeLessThan(budgetMs)
    expect(allText(pages).match(/a/g)).toHaveLength(20_000)
    expect(pastMargin(pages)).toEqual([])
  }, 60_000)

  it('lays out a huge title, company name and footer', async () => {
    const started = performance.now()
    const { result } = await render({
      filename: 'big.pdf',
      body: 'x',
      title: 'T'.repeat(200_000),
      branding: { companyName: 'C'.repeat(200_000), footerText: 'F'.repeat(1_600_000) },
    })
    expect(performance.now() - started).toBeLessThan(budgetMs)
    expect(result.content).toContain('footerText takes more than 6 lines')
  }, 60_000)

  it('lays out thousands of headings and short lines', async () => {
    let started = performance.now()
    await render({ filename: 'h.pdf', body: '# h\n'.repeat(2000) })
    expect(performance.now() - started).toBeLessThan(budgetMs)
    started = performance.now()
    await render({ filename: 'l.pdf', body: 'ab\n'.repeat(20000) })
    expect(performance.now() - started).toBeLessThan(budgetMs)
  }, 60_000)
})
