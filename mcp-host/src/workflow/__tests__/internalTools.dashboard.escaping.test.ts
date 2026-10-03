/**
 * Every text a model sends to the dashboard lands in an HTML file the user
 * opens, so each one must reach the page escaped. Each case puts a tag in one
 * field and finds it on the page as text, so the field is shown; dropping
 * escapeHtml from the code that prints that field fails it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { escapeHtml } from '../dashboardHtml'
import { INTERNAL_TOOLS } from '../internalTools'

const dashboard = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_dashboard')!
// An element the inline markdown reader keeps as text, unlike <img>, which it
// removes, so the tag reaches the escaping of every field that reads markdown.
const TAG = '<svg onload=alert(1)>'

/** The tag is on the page as text and nowhere as markup. */
function expectEscaped(html: string): void {
  expect(html).not.toMatch(/<svg onload/i)
  expect(html).toMatch(/&lt;svg onload=/i)
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-escape-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const cases: Array<[string, Record<string, unknown>]> = [
  ['the title', { title: TAG }],
  ['the headline', { title: 'T', headline: TAG }],
  ['a KPI label', { title: 'T', kpis: [{ label: TAG, value: '1' }] }],
  ['a KPI value', { title: 'T', kpis: [{ label: 'L', value: TAG }] }],
  ['a KPI delta', { title: 'T', kpis: [{ label: 'L', value: '1', delta: TAG }] }],
  ['a table title', { title: 'T', tables: [{ title: TAG, headers: ['A'], rows: [['1']] }] }],
  ['a table header', { title: 'T', tables: [{ headers: [TAG], rows: [['1']] }] }],
  ['a table cell', { title: 'T', tables: [{ headers: ['A'], rows: [[TAG]] }] }],
  [
    'a severity cell that names no severity',
    { title: 'T', tables: [{ headers: ['S'], rows: [[TAG]], columnTypes: { S: 'severity' } }] },
  ],
  [
    'a chart title',
    {
      title: 'T',
      charts: [{ type: 'bar', title: TAG, labels: ['a'], datasets: [{ data: [1] }] }],
    },
  ],
  ['a section title', { title: 'T', sections: [{ title: TAG, type: 'narrative', content: 'x' }] }],
  [
    'the text of a section',
    { title: 'T', sections: [{ title: 'S', type: 'narrative', content: `Text ${TAG}` }] },
  ],
  [
    'an item of a bullet section',
    { title: 'T', sections: [{ title: 'S', type: 'bullets', content: ['a', TAG] }] },
  ],
  ['the eyebrow', { title: 'T', eyebrow: TAG }],
  ['the status label', { title: 'T', status: 'green', statusLabel: TAG }],
  [
    'the language of a code section',
    { title: 'T', sections: [{ title: 'C', type: 'code', language: TAG, content: 'x' }] },
  ],
  [
    'the code of a code section',
    { title: 'T', sections: [{ title: 'C', type: 'code', content: TAG }] },
  ],
]

describe('dashboard text reaches the page escaped', () => {
  it.each(cases)('%s', async (_field, data) => {
    const result = await dashboard.execute(
      { filename: 'x.html', template: 'executive-brief', data },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expectEscaped(fs.readFileSync(result.artifact!.path, 'utf8'))
  })

  it.each([
    ['a service name', { title: 'T', services: [{ name: TAG, status: 'healthy' }] }],
    ['a service status', { title: 'T', services: [{ name: 'A', status: TAG }] }],
    ['a service metric', { title: 'T', services: [{ name: 'A', status: 'down', metric: TAG }] }],
    ['an incident title', { title: 'T', incidents: [{ time: '10:00', title: TAG }] }],
    ['an incident time', { title: 'T', incidents: [{ time: TAG, title: 'a' }] }],
    ['an incident severity', { title: 'T', incidents: [{ time: '1', title: 'a', severity: TAG }] }],
    ['a resolution time', { title: 'T', incidents: [{ time: '1', title: 'a', resolvedAt: TAG }] }],
    [
      'an incident that is not an object',
      { title: 'T', incidents: [{ time: '1', title: 'a' }, TAG] },
    ],
  ])('%s on the operations template', async (_field, data) => {
    const result = await dashboard.execute(
      { filename: 'x.html', template: 'operations-pulse', data },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expectEscaped(fs.readFileSync(result.artifact!.path, 'utf8'))
  })

  const chart = (spec: Record<string, unknown>) => ({
    type: 'bar',
    labels: ['a'],
    datasets: [{ data: [1] }],
    ...spec,
  })

  it.each([
    ['the label under a gauge', true, chart({ type: 'gauge', labels: [TAG] })],
    ['a chart type it cannot draw', true, chart({ type: TAG })],
    [
      'a series name in a chart shown as a table',
      false,
      chart({ datasets: [{ label: TAG, data: [1] }] }),
    ],
    ['a category in a chart shown as a table', false, chart({ labels: [TAG] })],
  ])('%s', async (_field, inlineChartJs, spec) => {
    // A chart that draws beside it, so the page is written when this one cannot be.
    const charts = [spec, chart({})]
    const result = await dashboard.execute(
      { filename: 'x.html', inlineChartJs, data: { title: 'T', charts } },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expectEscaped(fs.readFileSync(result.artifact!.path, 'utf8'))
  })
})

// The reader removes an <img> outright, so an image tag is only ever text or
// gone: never markup. The word after it shows the field was printed.
const IMG = '<img src=x onerror=alert(1)>Witness'

describe('an image tag in dashboard text', () => {
  it.each(cases)('never reaches %s as markup', async (_field, data) => {
    const sent = JSON.stringify(data).split(JSON.stringify(TAG).slice(1, -1)).join(IMG)
    const withImg = JSON.parse(sent)
    const result = await dashboard.execute(
      { filename: 'x.html', template: 'executive-brief', data: withImg },
      dir
    )
    expect(result.success, result.error).toBe(true)
    // Table cells may break long words with <wbr>.
    const html = fs.readFileSync(result.artifact!.path, 'utf8').replace(/<wbr>/g, '')
    expect(html).not.toMatch(/<img src=x/i)
    expect(html).toContain('Witness')
  })
})

describe('dashboard text outside the data', () => {
  it('escapes the company name in the footer', async () => {
    const result = await dashboard.execute(
      { filename: 'x.html', data: { title: 'T' }, branding: { companyName: TAG } },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expectEscaped(fs.readFileSync(result.artifact!.path, 'utf8'))
  })

  it('escapes a value quoted in the notice that replaces a block it cannot show', async () => {
    const result = await dashboard.execute(
      {
        filename: 'x.html',
        template: 'custom',
        data: {
          title: 'T',
          blocks: [{ type: TAG }, { type: 'kpis', items: [{ label: 'A', value: '1' }] }],
        },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expectEscaped(fs.readFileSync(result.artifact!.path, 'utf8'))
  })

  it('puts no inherited name into a badge class', async () => {
    const result = await dashboard.execute(
      {
        filename: 'x.html',
        data: {
          title: 'T',
          tables: [
            { headers: ['S'], rows: [['constructor'], ['high']], columnTypes: { S: 'severity' } },
          ],
        },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    const html = fs.readFileSync(result.artifact!.path, 'utf8')
    expect(html).not.toMatch(/native code|function Object/)
    expect(html).toContain('severity-high')
  })
})

describe('dashboard inline markdown', () => {
  const narrative = async (content: string): Promise<string> => {
    const result = await dashboard.execute(
      {
        filename: 'n.html',
        data: { title: 'T', sections: [{ title: 'S', type: 'narrative', content }] },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    const html = fs.readFileSync(result.artifact!.path, 'utf8')
    return html.slice(html.indexOf('class="narrative"'))
  }

  it('reads the markdown the PDF and DOCX text reads', async () => {
    const html = await narrative('**Bold** *it* `code` ~~old~~ [docs](https://x.test/a)')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('<em>it</em>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<s>old</s>')
    expect(html).toContain(
      '<a href="https:&#x2F;&#x2F;x.test&#x2F;a" rel="noopener noreferrer">docs</a>'
    )
  })

  it('prints an escaped mark as the mark, as the documents do', async () => {
    const html = await narrative('Use \\*args\\* here')
    expect(html).toContain('Use *args* here')
  })

  it('links only to web and mail targets, with the target escaped', async () => {
    const html = await narrative(
      '<a href="javascript:alert(1)">x</a> [y](https://x.test/"onmouseover=alert(1))'
    )
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toMatch(/"onmouseover/i)
    expect(html).toContain('&quot;onmouseover')
  })
})

describe('escapeHtml', () => {
  it('escapes every character that can open markup or end an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;&#x2F;a&gt;'
    )
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })
})
