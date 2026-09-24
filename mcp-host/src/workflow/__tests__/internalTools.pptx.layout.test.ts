/**
 * PowerPoint does not shrink text to fit on open or export, and a table grows
 * past the slide instead of continuing, so the deck is laid out from measured
 * text. These tests check the geometry in the slide XML against that measurement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fitText, textBlockHeight } from '../pptxText'
import {
  generatePptx,
  shapeWithText,
  slideCount,
  slideXml,
  tables,
  textShapes,
  writeImage,
} from './support/pptxXml'
import { zipEntryText } from './support/zipEntries'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-pptx-layout-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

const WIDE = { width: 13.333, height: 7.5 }
const SIXTEEN_NINE = { width: 10, height: 5.625 }
/** Top of the footer band; body content must end above it. */
const footerTop = (height: number) => height - 0.45

const long = (n: number, word = 'lorem') =>
  Array.from({ length: n }, (_, i) => `${word}${i % 7}`).join(' ')

describe('clerum__generate_pptx — long tables continue on further slides', () => {
  it('splits a 30-row table across slides, repeating the header, and says so', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [
      `10:${String(i).padStart(2, '0')}`,
      `Event ${i}`,
    ])
    const result = await generatePptx(
      {
        filename: 't.pptx',
        slides: [
          { layout: 'title-table', title: 'Timeline', table: { headers: ['Time', 'Event'], rows } },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 't.pptx')
    const count = slideCount(file)
    expect(count).toBeGreaterThan(1)

    const seen: string[] = []
    for (let n = 1; n <= count; n++) {
      const [table] = tables(slideXml(file, n))
      expect(table.rows[0]).toEqual(['Time', 'Event'])
      const bottom = table.y + table.rowHeights.reduce((a, b) => a + b, 0)
      expect(bottom).toBeLessThanOrEqual(footerTop(WIDE.height))
      seen.push(...table.rows.slice(1).map(r => r[1]))
    }
    expect(seen).toEqual(rows.map(r => r[1]))
    expect(result.content).toMatch(/slides\[0\]\.table/)
  })

  it('declares each row at least as tall as its wrapped text', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => [
      `Region ${i}`,
      long(40),
      String(i * 1000),
      long(18, 'status'),
      'x',
      'y',
      'z',
      long(10),
    ])
    const result = await generatePptx(
      {
        filename: 't.pptx',
        slides: [
          {
            layout: 'title-table',
            title: 'Wide',
            table: { headers: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], rows },
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 't.pptx')
    for (let n = 1; n <= slideCount(file); n++) {
      const xml = slideXml(file, n)
      const [table] = tables(xml)
      const size = Number(/<a:tc>[\s\S]*?sz="(\d+)"/.exec(xml)![1]) / 100
      table.rows.forEach((row, r) => {
        const needed = Math.max(
          ...row.map((cell, c) =>
            textBlockHeight([cell], size, table.columnWidths[c] - 0.2, { bold: r === 0 })
          )
        )
        expect(table.rowHeights[r]).toBeGreaterThanOrEqual(needed + 0.1 - 1e-3)
      })
      const bottom = table.y + table.rowHeights.reduce((a, b) => a + b, 0)
      expect(bottom).toBeLessThanOrEqual(footerTop(WIDE.height))
    }
  })

  it('gives a column of long text more width than a column of short codes', async () => {
    const result = await generatePptx(
      {
        filename: 't.pptx',
        slides: [
          {
            layout: 'title-table',
            title: 'Widths',
            table: {
              headers: ['ID', 'Description'],
              rows: [
                ['1', long(20)],
                ['2', long(25)],
              ],
            },
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const [table] = tables(slideXml(path.join(outputDir, 't.pptx'), 1))
    expect(table.columnWidths[1]).toBeGreaterThan(table.columnWidths[0] * 3)
  })
})

describe('clerum__generate_pptx — text stays inside its box', () => {
  it('keeps a long title clear of the body and the body clear of the footer', async () => {
    const title = long(24, 'Quarterly')
    const bullets = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? long(28) : `Point ${i}`))
    const result = await generatePptx(
      {
        filename: 'o.pptx',
        aspectRatio: '16x9',
        slides: [{ layout: 'title-bullets', title, bullets }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'o.pptx')
    const texts: string[] = []
    for (let n = 1; n <= slideCount(file); n++) {
      const xml = slideXml(file, n)
      const titleShape = shapeWithText(xml, 'Quarterly')
      const body = textShapes(xml).find(s => s.paragraphs.some(p => /^(Point|lorem)/.test(p)))!
      expect(body.anchor).toBe('t')
      const titleNeed = textBlockHeight(
        titleShape.paragraphs,
        titleShape.sizes[0],
        titleShape.w - 0.2,
        {
          bold: true,
        }
      )
      expect(titleShape.h).toBeGreaterThanOrEqual(titleNeed + 0.1 - 1e-3)
      expect(body.y).toBeGreaterThanOrEqual(titleShape.y + titleShape.h)
      const need = textBlockHeight(body.paragraphs, body.sizes[0], body.w - 0.2 - 27 / 72, {
        paraSpaceAfter: 8,
      })
      expect(need + 0.1).toBeLessThanOrEqual(body.h + 1e-3)
      expect(body.y + body.h).toBeLessThanOrEqual(footerTop(SIXTEEN_NINE.height))
      texts.push(...body.paragraphs)
    }
    expect(texts).toEqual(bullets)
  })

  it('shortens a bullet of many lines to what fits, counting the spacing of each line', async () => {
    const bullet = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const result = await generatePptx(
      {
        filename: 'n.pptx',
        aspectRatio: '16x9',
        slides: [{ layout: 'title-bullets', title: 'Lines', bullets: [bullet] }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/shortened/)
    const body = shapeWithText(slideXml(path.join(outputDir, 'n.pptx'), 1), 'line 0')
    const need = textBlockHeight(body.paragraphs, body.sizes[0], body.w - 0.2 - 27 / 72, {
      paraSpaceAfter: 8,
    })
    expect(need + 0.1).toBeLessThanOrEqual(body.h + 1e-3)
  })

  it('puts a long cover subtitle below a three-line cover title', async () => {
    const result = await generatePptx(
      {
        filename: 'c.pptx',
        slides: [{ layout: 'cover', title: long(22, 'Annual'), subtitle: 'Subtitle line' }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'c.pptx'), 1)
    const title = shapeWithText(xml, 'Annual')
    const subtitle = shapeWithText(xml, 'Subtitle line')
    const need = textBlockHeight(title.paragraphs, title.sizes[0], title.w - 0.2, { bold: true })
    expect(title.h).toBeGreaterThanOrEqual(need + 0.1 - 1e-3)
    expect(subtitle.y).toBeGreaterThanOrEqual(title.y + title.h)
  })

  it('fits a long KPI value on one line of its card', async () => {
    const result = await generatePptx(
      {
        filename: 'k.pptx',
        aspectRatio: '16x9',
        slides: [
          {
            layout: 'kpis',
            title: 'KPIs',
            kpis: [
              { label: 'Revenue', value: '$12,345,678.90' },
              { label: 'Users', value: 1204 },
              { label: 'NPS', value: 48 },
              { label: 'Churn', value: '2.1%' },
            ],
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const value = shapeWithText(slideXml(path.join(outputDir, 'k.pptx'), 1), '$12,345,678.90')
    expect(value.xml).toContain('wrap="none"')
    const need = textBlockHeight(value.paragraphs, value.sizes[0], value.w - 0.2, { bold: true })
    expect(need).toBeLessThanOrEqual((value.sizes[0] * 1.2) / 72 + 1e-3)
  })

  it('sets every KPI value on a slide at one size and centres a short last row', async () => {
    const values = ['1%', '2%', '$1,234,567.89', '4%', '5%']
    const result = await generatePptx(
      {
        filename: 'k5.pptx',
        slides: [
          {
            layout: 'kpis',
            title: 'KPIs',
            kpis: values.map((value, i) => ({ label: `K${i + 1}`, value })),
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'k5.pptx'), 1)
    const shapes = values.map(v => shapeWithText(xml, v))
    expect(new Set(shapes.map(s => s.sizes[0])).size).toBe(1)
    for (const s of shapes) expect(s.xml).toContain('wrap="none"')
    // Three cards in the first row, two in the second, both rows centred on the slide.
    const rows = [...new Set(shapes.map(s => s.y.toFixed(3)))]
    expect(rows).toHaveLength(2)
    const centre = (row: typeof shapes) =>
      (Math.min(...row.map(s => s.x)) + Math.max(...row.map(s => s.x + s.w))) / 2
    const first = shapes.filter(s => s.y.toFixed(3) === rows[0])
    const second = shapes.filter(s => s.y.toFixed(3) === rows[1])
    expect(first).toHaveLength(3)
    expect(second).toHaveLength(2)
    expect(centre(second)).toBeCloseTo(centre(first), 2)
    expect(centre(first)).toBeCloseTo(13.333 / 2, 2)
  })

  it('lines the values up when one KPI label takes two lines', async () => {
    const result = await generatePptx(
      {
        filename: 'kl.pptx',
        aspectRatio: '16x9',
        slides: [
          {
            layout: 'kpis',
            title: 'KPIs',
            kpis: [
              { label: 'Net revenue retention across enterprise accounts', value: '112%' },
              { label: 'NPS', value: '48' },
              { label: 'Churn', value: '2.1%' },
              { label: 'ARR', value: '$4.2M' },
            ],
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'kl.pptx'), 1)
    const ys = ['112%', '48', '2.1%', '$4.2M'].map(v => shapeWithText(xml, v).y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-3)
  })

  it('sets the deck in one font family, with no Helvetica on the cover', async () => {
    const result = await generatePptx(
      { filename: 'f.pptx', slides: [{ layout: 'cover', title: 'Fonts', subtitle: 'One family' }] },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'f.pptx')
    expect(slideXml(file, 1)).not.toContain('Helvetica')
    const theme = zipEntryText(file, 'ppt/theme/theme1.xml')
    const latin = [...theme.matchAll(/<a:(?:major|minor)Font><a:latin typeface="([^"]+)"/g)].map(
      m => m[1]
    )
    expect(latin).toEqual(['Arial', 'Arial'])
  })

  it('keeps a KPI value that wraps above the delta, and says when it is cut', async () => {
    const value = '$1,234,567,890.12 annual recurring revenue across all regions and segments'
    const kpis = Array.from({ length: 8 }, (_, i) => ({
      label: `Metric ${i}`,
      value,
      delta: '+12% vs last quarter',
      deltaDirection: 'up',
    }))
    const result = await generatePptx(
      {
        filename: 'k.pptx',
        aspectRatio: '16x9',
        slides: [{ layout: 'kpis', title: 'KPIs', kpis }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'k.pptx'), 1)
    const shownValue = shapeWithText(xml, '$1,234,567,890.12')
    const delta = shapeWithText(xml, '▲ +12%')
    expect(shownValue.y + shownValue.h).toBeLessThanOrEqual(delta.y + 1e-3)
    expect(result.content).toContain('slides[0].kpis[0].value is too long for its space')
  })

  it('says when an eyebrow or a quote attribution is shortened to one line', async () => {
    const result = await generatePptx(
      {
        filename: 'e.pptx',
        aspectRatio: '16x9',
        slides: [
          { layout: 'section', eyebrow: long(14, 'chapter'), title: 'Results' },
          { layout: 'quote', quote: { text: 'Short.', attribution: long(30, 'Author') } },
          { layout: 'section', eyebrow: 'Part two', title: 'Plans' },
          { layout: 'quote', quote: { text: 'Short.', attribution: 'Aristotle' } },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'e.pptx')
    expect(shapeWithText(slideXml(file, 1), 'CHAPTER0').paragraphs[0]).toMatch(/…$/)
    expect(result.content).toContain('slides[0].eyebrow is too long for one line and was shortened')
    expect(result.content).toContain(
      'slides[1].quote.attribution is too long for one line and was shortened'
    )
    expect(result.content).not.toMatch(/slides\[[23]\]/)
  })
})

describe('clerum__generate_pptx — two-column bullets that do not fit', () => {
  const twoColumn = (left: string[]) => ({
    filename: 'c.pptx',
    aspectRatio: '16x9',
    slides: [
      {
        layout: 'two-column',
        title: 'Columns',
        columns: {
          left: { type: 'bullets', bullets: left },
          right: { type: 'narrative', text: 'Short.' },
        },
      },
    ],
  })

  it('says a bullet was shortened, not that zero bullets were left out', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const result = await generatePptx(twoColumn([long]), outputDir)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/columns\.left\.bullets\[0\] is too long for the column/)
    expect(result.content).not.toMatch(/\b0 bullet/)
    const column = shapeWithText(slideXml(path.join(outputDir, 'c.pptx'), 1), 'line 0')
    const need = textBlockHeight(column.paragraphs, column.sizes[0], column.w - 0.2 - 27 / 72, {
      paraSpaceAfter: 6,
    })
    expect(need + 0.1).toBeLessThanOrEqual(column.h + 1e-3)
  })

  it('counts the bullets left out', async () => {
    const items = Array.from({ length: 40 }, (_, i) => `Bullet number ${i}`)
    const result = await generatePptx(twoColumn(items), outputDir)
    expect(result.success, result.error).toBe(true)
    const kept = textShapes(slideXml(path.join(outputDir, 'c.pptx'), 1)).find(
      s => s.paragraphs[0] === 'Bullet number 0'
    )!.paragraphs.length
    expect(kept).toBeLessThan(40)
    expect(result.content).toContain(
      `slides[0].columns.left.bullets: the last ${40 - kept} of 40 bullets did not fit`
    )
    const column = shapeWithText(slideXml(path.join(outputDir, 'c.pptx'), 1), 'Bullet number 0')
    const oneMore = fitText(items.slice(0, kept + 1), column, [14, 13, 12, 11], {
      paraSpaceAfter: 6,
      indent: 27 / 72,
    })
    expect(oneMore.fits).toBe(false)
  })

  it('lays out thousands of bullets in linear time', async () => {
    const items = Array.from(
      { length: 2000 },
      (_, i) => `Item ${i}: the quick brown fox jumps over the lazy dog near the river bank`
    )
    const started = performance.now()
    const column = await generatePptx(twoColumn(items), outputDir)
    const list = await generatePptx(
      {
        filename: 'l.pptx',
        slides: [{ layout: 'title-bullets', title: 'List', bullets: [...items, ...items] }],
      },
      outputDir
    )
    expect(column.success && list.success).toBe(true)
    // Well over the time this takes, so a slow machine passes; a quadratic layout takes minutes.
    expect(performance.now() - started).toBeLessThan(10_000)
  }, 30_000)
})

describe('clerum__generate_pptx — bullets written as Markdown', () => {
  const bulletParagraphs = (xml: string) =>
    [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(m => m[1]).filter(p => p.includes('<a:buChar'))

  it('drops a list marker the slide bullet would print again', async () => {
    const result = await generatePptx(
      {
        filename: 'm.pptx',
        slides: [
          {
            layout: 'title-bullets',
            title: 'Markers',
            bullets: ['- First', '* Second', '• Third', '-5% margin', '1. Step one'],
          },
          { layout: 'title-bullets', title: 'One string', bullets: '- Alpha\n- Beta' },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'm.pptx')
    expect(shapeWithText(slideXml(file, 1), 'First').paragraphs).toEqual([
      'First',
      'Second',
      'Third',
      '-5% margin',
      '1. Step one',
    ])
    expect(shapeWithText(slideXml(file, 2), 'Alpha').paragraphs).toEqual(['Alpha', 'Beta'])
  })

  it('keeps the lines of one bullet under that bullet', async () => {
    const result = await generatePptx(
      {
        filename: 'l.pptx',
        slides: [
          { layout: 'title-bullets', title: 'Lines', bullets: ['Line one\nline two', 'Next'] },
          {
            layout: 'two-column',
            title: 'Columns',
            columns: {
              left: { type: 'bullets', bullets: ['Split\nhere', 'Other'] },
              right: { type: 'narrative', text: 'Short.' },
            },
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'l.pptx')
    for (const [slide, first] of [
      [1, 'Line one'],
      [2, 'Split'],
    ] as const) {
      const paragraphs = bulletParagraphs(slideXml(file, slide))
      expect(paragraphs).toHaveLength(2)
      expect(paragraphs[0]).toContain(`<a:t>${first}</a:t>`)
      expect(paragraphs[0]).toContain('<a:br/>')
    }
  })
})

describe('clerum__generate_pptx — slide XML', () => {
  it('gives each paragraph its properties once, before its first run', async () => {
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [
          {
            layout: 'title-bullets',
            title: 'الإيرادات في Q3',
            bullets: ['الإيرادات ارتفعت بنسبة 12% في Q3', 'Two\nlines', 'Plain'],
          },
          {
            layout: 'title-table',
            title: 'Table',
            table: { headers: ['المنطقة', 'Q3'], rows: [['الرياض في Q3', '1,200']] },
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'x.pptx')
    for (const slide of [1, 2]) {
      for (const [, inner] of slideXml(file, slide).matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
        const props = inner.match(/<a:pPr\b/g) ?? []
        expect(props.length).toBeLessThanOrEqual(1)
        if (props.length === 1) expect(inner.startsWith('<a:pPr')).toBe(true)
      }
    }
  })
})

describe('clerum__generate_pptx — scripts other than Latin', () => {
  it('tags Chinese, Japanese and Korean runs with their language', async () => {
    const result = await generatePptx(
      {
        filename: 'l.pptx',
        slides: [
          {
            layout: 'title-bullets',
            title: '多语言支持',
            bullets: ['营收同比增长 12%，超出预期', 'ひらがなとカタカナ', '한국어 매출 증가'],
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'l.pptx'), 1)
    expect(xml).toMatch(/lang="zh-CN"[^>]*>[\s\S]*?<a:t>多语言支持<\/a:t>/)
    expect(xml).toMatch(/lang="zh-CN"[^>]*>[\s\S]*?<a:t>营收同比增长/)
    expect(xml).toMatch(/lang="ja-JP"[^>]*>[\s\S]*?<a:t>ひらがな/)
    expect(xml).toMatch(/lang="ko-KR"[^>]*>[\s\S]*?<a:t>한국어/)
  })

  it('gives Han characters alone the language of the deck', async () => {
    const result = await generatePptx(
      {
        filename: 'j.pptx',
        slides: [
          {
            layout: 'title-bullets',
            title: '売上概要',
            bullets: ['今期の売上は前年比で増加しました', '東京'],
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'j.pptx'), 1)
    expect(xml).toMatch(/lang="ja-JP"[^>]*>[\s\S]*?<a:t>売上概要<\/a:t>/)
    expect(xml).toMatch(/lang="ja-JP"[^>]*>[\s\S]*?<a:t>東京<\/a:t>/)
    expect(xml).not.toContain('zh-CN')
  })

  it('uses a bullet glyph PowerPoint sets in the Latin face in every language', async () => {
    const result = await generatePptx(
      {
        filename: 'b.pptx',
        slides: [{ layout: 'title-bullets', title: 'B', bullets: ['营收增长', 'English'] }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const chars = [
      ...slideXml(path.join(outputDir, 'b.pptx'), 1).matchAll(/<a:buChar char="([^"]+)"/g),
    ].map(m => m[1])
    expect(chars).toEqual(['&#x2022;', '&#x2022;'])
  })

  it('sets Arabic secondary text upright and unspaced, and keeps Latin italic', async () => {
    await writeImage(outputDir, 'pic.png', 800, 600)
    const result = await generatePptx(
      {
        filename: 'i.pptx',
        slides: [
          { layout: 'cover', title: 'مراجعة الأعمال', subtitle: 'الإيرادات والاحتفاظ بالعملاء' },
          { layout: 'section', eyebrow: 'القسم الأول', title: 'الأداء', subtitle: 'ملخص الربع' },
          { layout: 'quote', quote: { text: 'لقد خفضت الروبوتات الجديدة وقت التبديل.' } },
          { layout: 'image', title: 'صورة', image: { path: 'pic.png', caption: 'تعليق الصورة' } },
          { layout: 'section', eyebrow: 'Part one', title: 'Results', subtitle: 'Latin italic' },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'i.pptx')
    const runOf = (slide: number, text: string) => {
      const hit = new RegExp(`<a:rPr[^>]*>(?:(?!<a:rPr)[\\s\\S])*?<a:t>${text}`).exec(
        slideXml(file, slide)
      )
      if (!hit) throw new Error(`no run for ${text}`)
      return /<a:rPr[^>]*>/.exec(hit[0])![0]
    }
    for (const [slide, text] of [
      [1, 'الإيرادات'],
      [2, 'ملخص'],
      [3, 'لقد'],
      [4, 'تعليق'],
    ] as const) {
      expect(runOf(slide, text)).not.toContain('i="1"')
      expect(runOf(slide, text)).toContain('lang="ar-SA"')
    }
    expect(runOf(2, 'القسم')).not.toContain('spc=')
    expect(runOf(5, 'Latin italic')).toContain('i="1"')
    expect(runOf(5, 'PART ONE')).toContain('spc="400"')
  })

  it('lays out an Arabic paragraph right to left', async () => {
    const result = await generatePptx(
      {
        filename: 'r.pptx',
        slides: [
          {
            layout: 'title-bullets',
            title: 'Mixed',
            bullets: ['English first', 'الإيرادات ارتفعت بنسبة ١٢٪'],
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'r.pptx'), 1)
    const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map(m => m[1])
    const arabic = paragraphs.find(p => p.includes('الإيرادات'))!
    const english = paragraphs.find(p => p.includes('English first'))!
    expect(arabic).toMatch(/<a:pPr[^>]*rtl="1"/)
    expect(arabic).toMatch(/algn="r"/)
    expect(arabic).toMatch(/lang="ar-SA"/)
    expect(english).not.toMatch(/rtl="1"/)
  })
})
