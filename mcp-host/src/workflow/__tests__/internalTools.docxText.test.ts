/**
 * The DOCX generator's reading of inline markdown and of right-to-left and
 * CJK text: what each run of document.xml says and how it is formatted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { inlineRuns } from '../docxInline'
import { documentEastAsianScript } from '../docxScript'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolResult } from '../types'
import { zipEntryText } from './support/zipEntries'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-docx-text-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function generate(args: Record<string, unknown>): Promise<InternalToolResult> {
  const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_docx')!
  return tool.execute({ filename: 'd.docx', ...args }, outputDir)
}

async function part(args: Record<string, unknown>, name = 'word/document.xml'): Promise<string> {
  const r = await generate(args)
  expect(r.success, r.error).toBe(true)
  return zipEntryText(r.artifact!.path, name)
}

interface Run {
  props: string
  text: string
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Every run with its properties and text, in order. */
function runs(xml: string): Run[] {
  return [...xml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map(m => ({
    props: /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(m[1])?.[1] ?? '',
    text: decode([...m[1].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]).join('')),
  }))
}

function bodyParagraphs(xml: string): string[] {
  const body = xml.slice(xml.indexOf('<w:body>'))
  return body.match(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/g) ?? []
}

function paragraphText(p: string): string {
  return runs(p)
    .map(r => r.text)
    .join('')
}

/** The runs with text in the document written from `body`. */
async function paragraphRuns(body: string): Promise<Run[]> {
  return runs(await part({ body })).filter(r => r.text !== '')
}

describe('generate_docx emphasis', () => {
  it('keeps the asterisks of arithmetic', async () => {
    const found = await paragraphRuns('Math 5 * 3 * 2 = 30')
    expect(found.map(r => r.text).join('')).toBe('Math 5 * 3 * 2 = 30')
    expect(found.some(r => r.props.includes('<w:i/>'))).toBe(false)
  })

  it('keeps asterisks that have a space on their inner side', async () => {
    const found = await paragraphRuns('a ** b ** c and x * y')
    expect(found.map(r => r.text).join('')).toBe('a ** b ** c and x * y')
    expect(found.some(r => /<w:[bi]\/>/.test(r.props))).toBe(false)
  })

  it('reads ***bold italic*** as one run that is both', async () => {
    const found = await paragraphRuns('A ***bold italic*** B')
    expect(found.map(r => r.text).join('')).toBe('A bold italic B')
    const run = found.find(r => r.text === 'bold italic')!
    expect(run.props).toContain('<w:b/>')
    expect(run.props).toContain('<w:i/>')
  })

  it('strikes ~~text~~ through', async () => {
    const found = await paragraphRuns('B ~~strike~~ C')
    expect(found.map(r => r.text).join('')).toBe('B strike C')
    expect(found.find(r => r.text === 'strike')!.props).toContain('<w:strike/>')
  })

  it('strikes <s> and <del> through', async () => {
    const found = await paragraphRuns('a <s>old</s> <del>gone</del> b')
    expect(found.find(r => r.text === 'old')!.props).toContain('<w:strike/>')
    expect(found.find(r => r.text === 'gone')!.props).toContain('<w:strike/>')
  })

  it('prints a backslash-escaped marker literally and drops the backslash', async () => {
    const found = await paragraphRuns('C \\*not italic\\* and \\_x\\_ and \\\\ and C:\\Users\\me')
    expect(found.map(r => r.text).join('')).toBe('C *not italic* and _x_ and \\ and C:\\Users\\me')
    expect(found.some(r => r.props.includes('<w:i/>'))).toBe(false)
  })

  it('reads emphasis nested in bold', async () => {
    const found = await paragraphRuns('**bold *both* ~~gone~~ `code`**')
    expect(found.map(r => r.text).join('')).toBe('bold both gone code')
    const both = found.find(r => r.text === 'both')!
    expect(both.props).toContain('<w:b/>')
    expect(both.props).toContain('<w:i/>')
    expect(found.find(r => r.text === 'gone')!.props).toContain('<w:strike/>')
    expect(found.find(r => r.text === 'code')!.props).toContain('Consolas')
  })

  it('keeps escapes and markers inside code spans as written', async () => {
    const found = await paragraphRuns('Use `a \\* b *c*` here')
    expect(found.map(r => r.text).join('')).toBe('Use a \\* b *c* here')
  })

  it('still reads single-character emphasis', async () => {
    const found = await paragraphRuns('*a* and **b**')
    expect(found.find(r => r.text === 'a')!.props).toContain('<w:i/>')
    expect(found.find(r => r.text === 'b')!.props).toContain('<w:b/>')
  })

  const LENGTH = 100_000
  const repeat = (unit: string) => unit.repeat(Math.ceil(LENGTH / unit.length))
  it.each([
    ['bold openers whose closers follow a space', repeat('**a ')],
    ['italic openers whose closers follow a space', repeat('*a ')],
    ['bold italic openers', repeat('***a ')],
    ['strike openers', repeat('~~a ')],
    ['backslashes', repeat('\\')],
    ['asterisks', repeat('*')],
    ['right-to-left text with marks', repeat('\u0628\u064e ')],
  ])(
    'reads a line of %s in linear time',
    (_name, line) => {
      const started = Date.now()
      inlineRuns(line, {}, [])
      expect(Date.now() - started).toBeLessThan(5000)
    },
    30_000
  )
})

describe('generate_docx right-to-left text', () => {
  const ARABIC = 'مرحبا بالعالم، هذا تقرير المبيعات.'

  it('sets an Arabic paragraph right to left without flipping its alignment', async () => {
    const xml = await part({ body: `${ARABIC}\n\nEnglish paragraph.` })
    const [arabic, english] = bodyParagraphs(xml).filter(p => paragraphText(p) !== '')
    expect(arabic).toContain('<w:bidi/>')
    // In a bidi paragraph Word reads jc="right" as the far edge, so the paragraph keeps its
    // default, which is the right margin.
    expect(arabic).not.toMatch(/<w:jc /)
    expect(english).not.toContain('<w:bidi/>')
    const arabicRuns = runs(arabic).filter(r => r.text.trim() !== '')
    expect(arabicRuns.length).toBeGreaterThan(0)
    for (const run of arabicRuns.filter(r => /\p{Script=Arabic}/u.test(r.text))) {
      expect(run.props).toContain('<w:rtl/>')
      expect(run.props).toMatch(/<w:lang [^>]*w:bidi="ar-SA"/)
    }
    expect(runs(english).some(r => r.props.includes('<w:rtl/>'))).toBe(false)
  })

  it('sets RTL list items, headings, quotes and table cells right to left', async () => {
    const xml = await part({
      body:
        '# عنوان التقرير\n\n- البند الأول\n1. פריט ראשון\n\n> اقتباس\n\n' +
        '| المنطقة | الإيرادات |\n|---|---|\n| الرياض | 1,200 |',
    })
    const paragraphs = bodyParagraphs(xml)
    for (const text of ['عنوان التقرير', 'البند الأول', 'פריט ראשון', 'اقتباس', 'الرياض']) {
      const p = paragraphs.find(x => paragraphText(x) === text)
      expect(p, text).toBeDefined()
      expect(p, text).toContain('<w:bidi/>')
    }
    expect(xml).toContain('<w:bidiVisual/>')
    const hebrew = runs(xml).find(r => r.text === 'פריט ראשון')!
    expect(hebrew.props).toMatch(/w:bidi="he-IL"/)
  })

  it('lays out a table with RTL headers right to left and one with LTR headers left to right', async () => {
    const rtl = await part({
      body: 'x',
      tables: [{ headers: ['المنطقة', 'الإيرادات'], rows: [['الرياض', 1200]] }],
    })
    expect(rtl).toContain('<w:bidiVisual/>')
    const ltr = await part({
      body: 'x',
      tables: [{ headers: ['Region', 'Revenue'], rows: [['الرياض', 1200]] }],
    })
    expect(ltr).not.toContain('<w:bidiVisual/>')
  })

  it('keeps digits and punctuation after RTL words in their run', async () => {
    const xml = await part({
      body: 'تقرير المبيعات 2026\n\nשלום עולם עם מספר 42.\n\nAn English line 42.',
    })
    const paragraphs = bodyParagraphs(xml).filter(p => paragraphText(p) !== '')
    const numbered = (p: string, digits: string) => runs(p).find(r => r.text.includes(digits))!
    expect(numbered(paragraphs[0], '2026').props).toContain('<w:rtl/>')
    expect(numbered(paragraphs[1], '42').props).toContain('<w:rtl/>')
    expect(numbered(paragraphs[2], '42').props).not.toContain('<w:rtl/>')
  })

  it('splits a mixed line into runs, only the RTL ones marked', async () => {
    const xml = await part({ body: 'x', headline: 'Latin → العربية → עברית → 中文 ✓' })
    const headline = runs(xml).filter(r => r.props.includes('<w:i/>'))
    expect(headline.map(r => r.text).join('')).toBe('Latin → العربية → עברית → 中文 ✓')
    expect(headline.length).toBeGreaterThan(2)
    for (const run of headline) {
      const rtl = /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(run.text)
      expect(run.props.includes('<w:rtl/>'), run.text).toBe(rtl)
      if (rtl) expect(run.text, 'an RTL run holds no Latin or CJK').not.toMatch(/[A-Za-z中文]/)
    }
    // Word draws boxes for Arabic in a run tagged as Hebrew, so each script gets its own run.
    const arabic = headline.find(r => /\p{Script=Arabic}/u.test(r.text))!
    expect(arabic.text).not.toMatch(/\p{Script=Hebrew}/u)
    expect(arabic.props).toMatch(/w:bidi="ar-SA"/)
    expect(headline.find(r => /\p{Script=Hebrew}/u.test(r.text))!.props).toMatch(/w:bidi="he-IL"/)
  })

  it('draws the bar of an RTL quote on its right', async () => {
    const xml = await part({ body: '> اقتباس قصير\n\n> An English quote' })
    const [rtl, ltr] = bodyParagraphs(xml).filter(p => p.includes('<w:pBdr>'))
    expect(rtl).toMatch(/<w:pBdr><w:right /)
    expect(ltr).toMatch(/<w:pBdr><w:left /)
  })

  it('keeps the paragraphs of a quote apart and runs its other lines on', async () => {
    const xml = await part({ body: '> First line\n> runs on.\n>\n> Second paragraph.' })
    const quoted = bodyParagraphs(xml).filter(p => p.includes('<w:pBdr>'))
    expect(quoted.map(paragraphText)).toEqual(['First line runs on.', 'Second paragraph.'])
  })

  it('sets the title of an RTL document right to left', async () => {
    const xml = await part({ body: 'x', title: 'تقرير المبيعات' })
    const title = bodyParagraphs(xml).find(p => paragraphText(p) === 'تقرير المبيعات')
    expect(title).toContain('<w:bidi/>')
  })

  it('names a complex-script face that has Arabic and Hebrew', async () => {
    const styles = await part({ body: 'x' }, 'word/styles.xml')
    const defaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)![0]
    expect(defaults).toMatch(/<w:rFonts [^>]*w:ascii="Calibri"/)
    expect(defaults).toMatch(/<w:rFonts [^>]*w:cs="Arial"/)
  })

  it('keeps the complex-script face on inline code', async () => {
    const found = await paragraphRuns('`كود` text')
    const code = found.find(r => r.text === 'كود')!
    expect(code.props).toMatch(/w:ascii="Consolas"/)
    expect(code.props).not.toMatch(/w:cs="Consolas"/)
  })
})

describe('generate_docx CJK text', () => {
  const docDefaults = async (body: string) => {
    const styles = await part({ body }, 'word/styles.xml')
    return /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)![0]
  }

  it.each([
    ['日本語のレポート', 'Yu Gothic', 'ja-JP'],
    ['한국어 보고서', 'Malgun Gothic', 'ko-KR'],
  ])('names an East Asian face for %s', async (text, font, lang) => {
    const found = await paragraphRuns(`**${text}**`)
    const run = found.find(r => r.text === text)!
    expect(run.props).toContain(`w:eastAsia="${font}"`)
    expect(run.props).toMatch(new RegExp(`<w:lang [^>]*w:eastAsia="${lang}"`))
  })

  it('sets a document of Han characters alone in the Chinese face by default', async () => {
    const defaults = await docDefaults('**中文报告**')
    expect(defaults).toMatch(/<w:rFonts [^>]*w:eastAsia="Microsoft YaHei"/)
    expect(defaults).toMatch(/<w:lang [^>]*w:eastAsia="zh-CN"/)
    const run = (await paragraphRuns('**中文报告**')).find(r => r.text === '中文报告')!
    expect(run.props).not.toContain('w:eastAsia')
  })

  it('takes the document language from the lines that hold most of its CJK text', () => {
    const chinese = '营收同比增长，超出预期\n产品名：カメラ\n市场份额继续扩大'
    expect(documentEastAsianScript(chinese)?.lang).toBe('zh-CN')
    expect(documentEastAsianScript('売上概要\n今期の売上は増加しました')?.lang).toBe('ja-JP')
    expect(documentEastAsianScript('Plain English')).toBeUndefined()
  })

  it('gives Han characters alone the language of a Japanese document', async () => {
    const body =
      '# 売上概要\n\n今期の売上は前年比で増加しました。\n\n| 都市 | 売上 |\n|---|---|\n| 東京 | 120 |'
    const defaults = await docDefaults(body)
    expect(defaults).toMatch(/<w:rFonts [^>]*w:eastAsia="Yu Gothic"/)
    expect(defaults).toMatch(/<w:lang [^>]*w:eastAsia="ja-JP"/)
    const xml = await part({ body })
    expect(xml).not.toContain('zh-CN')
    expect(xml).not.toContain('Microsoft YaHei')
  })

  it('leaves Latin-only runs without an East Asian face', async () => {
    const found = await paragraphRuns('Plain English')
    expect(found.every(r => !r.props.includes('w:eastAsia'))).toBe(true)
  })
})
