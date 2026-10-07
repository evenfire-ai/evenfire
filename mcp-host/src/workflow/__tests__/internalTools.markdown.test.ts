/**
 * The markdown constructs the PDF and DOCX generators render instead of
 * printing literally.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolDefinition } from '../types'
import { type PdfPage, allText, readPdf } from './support/pdfText'
import { zipEntryText } from './support/zipEntries'

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-md-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function pdfPages(body: string, args: Record<string, unknown> = {}): Promise<PdfPage[]> {
  const r = await findTool('clerum__generate_pdf').execute(
    { filename: 'doc.pdf', title: 'Doc', body, ...args },
    outputDir
  )
  expect(r.success, r.error).toBe(true)
  return readPdf(path.join(outputDir, 'doc.pdf'))
}

/** Words are drawn one fragment at a time, so runs of spaces between them are collapsed. */
function shown(pages: PdfPage[]): string {
  return allText(pages).replace(/\s+/g, ' ')
}

/** The text the PDF shows, read back from its content streams. */
async function pdfText(body: string): Promise<string> {
  return shown(await pdfPages(body))
}

/** The PDF file itself, for the link annotations that are not drawn text. */
async function pdfRaw(body: string): Promise<string> {
  await pdfPages(body)
  return fs.readFileSync(path.join(outputDir, 'doc.pdf')).toString('latin1')
}

async function docxXml(body: string): Promise<string> {
  const r = await findTool('clerum__generate_docx').execute(
    { filename: 'doc.docx', title: 'Doc', body },
    outputDir
  )
  expect(r.success, r.error).toBe(true)
  return zipEntryText(path.join(outputDir, 'doc.docx'), 'word/document.xml')
}

describe('PDF markdown', () => {
  it('renders headings deeper than three hashes without printing them', async () => {
    const raw = await pdfText('#### Fourth level\n##### Fifth level')
    expect(raw).toContain('Fourth level')
    expect(raw).not.toContain('#')
  })

  it('builds a real ordered list', async () => {
    const raw = await pdfText('1. First\n2. Second\n3. Third')
    // pdfmake writes list markers itself; the source digits must not survive
    // as part of the item text.
    expect(raw).toContain('First')
    expect(raw).not.toContain('1. First')
  })

  it('keeps nested bullets at their own level', async () => {
    const r = await findTool('clerum__generate_pdf').execute(
      { filename: 'n.pdf', title: 'N', body: '- Top\n  - Nested\n- Second' },
      outputDir
    )
    expect(r.success).toBe(true)
    // A nested item is indented further than its parent, so the document is
    // measurably larger than the same three items flattened.
    const nested = fs.statSync(path.join(outputDir, 'n.pdf')).size
    const flatRes = await findTool('clerum__generate_pdf').execute(
      { filename: 'f.pdf', title: 'N', body: '- Top\n- Nested\n- Second' },
      outputDir
    )
    expect(flatRes.success).toBe(true)
    expect(nested).not.toBe(fs.statSync(path.join(outputDir, 'f.pdf')).size)
  })

  it('does not print code fences', async () => {
    const raw = await pdfText('```bash\nkubectl get pods\n```')
    expect(raw).toContain('kubectl get pods')
    expect(raw).not.toContain('```')
  })

  it('does not print blockquote markers', async () => {
    const raw = await pdfText('> Quoted line')
    expect(raw).toContain('Quoted line')
    expect(raw).not.toContain('>')
  })

  it('turns a markdown link into a PDF link annotation', async () => {
    const raw = await pdfRaw('See [the runbook](https://example.com/runbook) for detail.')
    expect(raw).toContain('/Link')
    expect(raw).toContain('example.com/runbook')
    const text = shown(await readPdf(path.join(outputDir, 'doc.pdf')))
    expect(text).toContain('the runbook')
    expect(text).not.toMatch(/[[\]()]/)
  })

  it('accepts every horizontal-rule spelling', async () => {
    const rules: Array<[string, string]> = [
      ['dash', '---'],
      ['star', '***'],
      ['under', '___'],
    ]
    for (const [name, rule] of rules) {
      const file = `rule-${name}.pdf`
      const r = await findTool('clerum__generate_pdf').execute(
        { filename: file, title: 'R', body: `a\n${rule}\nb` },
        outputDir
      )
      expect(r.success).toBe(true)
      const text = shown(await readPdf(path.join(outputDir, file)))
      expect(text).toContain('b')
      expect(text, `${rule} was printed as text`).not.toContain(rule)
    }
  })

  it('sets ***text*** in bold italic and prints escaped markers as themselves', async () => {
    const pages = await pdfPages('A ***bold italic*** B ~~strike~~ C \\*not italic\\* D \\_x\\_ E')
    const text = shown(pages)
    expect(text).toContain('*not italic*')
    expect(text).toContain('_x_')
    expect(text).not.toContain('\\')
    expect(text).not.toMatch(/\*bold|italic\*\*|~~/)
    const fontOf = (word: string) => pages[0].fragments.find(f => f.text.trim() === word)?.font
    expect(fontOf('bold')).toMatch(/(Bold|Medium).*(Italic|Oblique)/i)
    expect(fontOf('*not')).not.toMatch(/Italic|Oblique/i)
  })

  it('keeps balanced parentheses inside a link target', async () => {
    const raw = await pdfRaw('See [wiki](https://en.wikipedia.org/wiki/Foo_(bar)) end.')
    expect(raw.includes('/URI (https://en.wikipedia.org/wiki/Foo_\\(bar\\))')).toBe(true)
    const text = shown(await readPdf(path.join(outputDir, 'doc.pdf')))
    expect(text).toContain('wiki')
    expect(text).not.toContain(')')
  })

  it('drops the closing hashes of a heading', async () => {
    const text = await pdfText('## Section title ##\n# C# #\n### Issue #42')
    expect(text).toContain('Section title')
    expect(text).toContain('C#')
    expect(text).toContain('Issue #42')
    expect(text).not.toMatch(/title\s*#|C#\s*#/)
  })

  it('reads block-level HTML instead of printing its tags', async () => {
    const pages = await pdfPages(
      [
        '<h2>Sales</h2>',
        '<table><tr><th>Region</th></tr><tr><td>North</td></tr></table>',
        '<ul><li>alpha</li><li>beta</li></ul>',
        '<details><summary>Summary</summary>Hidden</details>',
        '<p>One</p><div>Two</div>',
      ].join('\n'),
      {
        title: 'HTML <b>mixed</b> &amp; title',
        headline: '<i>Head</i> line',
        coverPage: true,
        branding: { companyName: 'Acme <span>Corp</span>', footerText: 'Foot <b>note</b>' },
      }
    )
    const text = shown(pages)
    for (const word of [
      'Sales',
      'Region',
      'North',
      'alpha',
      'beta',
      'Summary',
      'Hidden',
      'One',
      'Two',
    ]) {
      expect(text).toContain(word)
    }
    expect(text).toContain('HTML mixed & title')
    expect(text).toContain('Head line')
    expect(text).toContain('Acme Corp')
    expect(text).toContain('Foot note')
    expect(text).not.toMatch(/[<>]|&amp;|SummaryHidden|OneTwo/)
    const body = pages[pages.length - 1].fragments
    const sales = body.find(f => f.text.trim() === 'Sales')
    const region = body.find(f => f.text.trim() === 'Region')
    expect(sales && region && region.y > sales.y).toBe(true)
  })

  it('honours the alignment a table separator declares', async () => {
    const body = '| A | B |\n| :--- | ---: |\n| 1 | 2 |'
    const r = await findTool('clerum__generate_pdf').execute(
      { filename: 'aligned.pdf', title: 'T', body },
      outputDir
    )
    expect(r.success).toBe(true)
    // Right-aligned cells shift their text origin, so the file differs from
    // the same table left-aligned throughout.
    const left = await findTool('clerum__generate_pdf').execute(
      { filename: 'left.pdf', title: 'T', body: '| A | B |\n| --- | --- |\n| 1 | 2 |' },
      outputDir
    )
    expect(left.success).toBe(true)
    expect(fs.statSync(path.join(outputDir, 'aligned.pdf')).size).not.toBe(
      fs.statSync(path.join(outputDir, 'left.pdf')).size
    )
  })
})

describe('DOCX markdown', () => {
  it('renders headings deeper than three hashes as headings', async () => {
    const xml = await docxXml('#### Fourth level')
    expect(xml).not.toContain('#### Fourth')
    expect(xml).toContain('Fourth level')
  })

  it('numbers an ordered list and bullets a bullet list from separate definitions', async () => {
    const xml = await docxXml('1. First\n2. Second\n\n- Alpha\n- Beta')
    const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map(m => m[1])
    expect(ids.length).toBe(4)
    // The two kinds must not share a numbering definition, or the bullets
    // continue the ordered list's sequence.
    expect(new Set(ids).size).toBe(2)
  })

  it('gives a nested bullet its own level', async () => {
    const xml = await docxXml('- Top\n  - Nested\n- Second')
    const levels = [...xml.matchAll(/<w:ilvl w:val="(\d+)"/g)].map(m => m[1])
    expect(levels).toContain('1')
  })

  it('sets code in a fixed-width face instead of printing the fences', async () => {
    const xml = await docxXml('```bash\nkubectl get pods\n```')
    expect(xml).not.toContain('```')
    expect(xml).toContain('Courier New')
  })

  it('renders a blockquote without its marker', async () => {
    const xml = await docxXml('> Quoted line')
    expect(xml).not.toContain('&gt; Quoted')
    expect(xml).toContain('Quoted line')
  })

  it('emits a real hyperlink', async () => {
    const xml = await docxXml('See [the runbook](https://example.com/runbook).')
    expect(xml).toContain('<w:hyperlink')
    expect(xml).not.toContain('[the runbook]')
  })
})

describe('link handling is restricted to safe schemes', () => {
  const HOSTILE = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]

  it('never turns a non-http scheme into a PDF link', async () => {
    for (const url of HOSTILE) {
      const raw = await pdfRaw(`Click [here](${url}) now.`)
      // The text is still shown, but no link annotation is created for it.
      expect(raw, `${url} became a link`).not.toContain('/Link')
    }
  })

  it('never turns a non-http scheme into a DOCX hyperlink', async () => {
    for (const url of HOSTILE) {
      const xml = await docxXml(`Click [here](${url}) now.`)
      expect(xml, `${url} became a hyperlink`).not.toContain('<w:hyperlink')
    }
  })

  it('still links ordinary http and mailto targets', async () => {
    expect(await pdfRaw('[a](https://example.com)')).toContain('/Link')
    expect(await pdfRaw('[a](http://example.com)')).toContain('/Link')
    expect(await docxXml('[a](mailto:x@example.com)')).toContain('<w:hyperlink')
  })
})
