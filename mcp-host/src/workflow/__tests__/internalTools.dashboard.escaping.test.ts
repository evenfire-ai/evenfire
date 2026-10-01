/**
 * Every text a model sends to the dashboard lands in an HTML file the user
 * opens, so each one must reach the page escaped. Each case puts a tag in one
 * field; dropping escapeHtml from the code that prints that field fails it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { escapeHtml } from '../dashboardHtml'
import { INTERNAL_TOOLS } from '../internalTools'

const dashboard = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_dashboard')!
const TAG = '<img src=x onerror=alert(1)>'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-escape-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const cases: Array<[string, Record<string, unknown>]> = [
  ['the title', { title: TAG }],
  ['the subtitle', { title: 'T', subtitle: TAG }],
  ['a KPI label', { title: 'T', kpis: [{ label: TAG, value: '1' }] }],
  ['a KPI value', { title: 'T', kpis: [{ label: 'L', value: TAG }] }],
  ['a KPI delta', { title: 'T', kpis: [{ label: 'L', value: '1', delta: TAG }] }],
  ['a table title', { title: 'T', tables: [{ title: TAG, headers: ['A'], rows: [['1']] }] }],
  ['a table header', { title: 'T', tables: [{ headers: [TAG], rows: [['1']] }] }],
  ['a table cell', { title: 'T', tables: [{ headers: ['A'], rows: [[TAG]] }] }],
  [
    'a badge cell',
    { title: 'T', tables: [{ headers: ['S'], rows: [[TAG]], columnTypes: { S: 'severity' } }] },
  ],
  [
    'a chart title',
    {
      title: 'T',
      charts: [{ type: 'bar', title: TAG, labels: ['a'], datasets: [{ data: [1] }] }],
    },
  ],
  [
    'a section',
    { title: 'T', sections: [{ title: TAG, type: 'narrative', content: `Text ${TAG}` }] },
  ],
  ['the eyebrow', { title: 'T', eyebrow: TAG }],
  ['the status label', { title: 'T', status: 'green', statusLabel: TAG }],
  [
    'a code section',
    { title: 'T', sections: [{ title: 'C', type: 'code', language: TAG, content: TAG }] },
  ],
]

describe('dashboard text reaches the page escaped', () => {
  it.each(cases)('%s', async (_field, data) => {
    const result = await dashboard.execute(
      { filename: 'x.html', template: 'executive-brief', data },
      dir
    )
    expect(result.success, result.error).toBe(true)
    const html = fs.readFileSync(result.artifact!.path, 'utf8')
    expect(html).not.toMatch(/<img src=x/i)
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
    const html = fs.readFileSync(result.artifact!.path, 'utf8')
    expect(html).not.toMatch(/<img src=x/i)
    expect(html).toMatch(/&lt;img/i)
  })
})

describe('dashboard text outside the data', () => {
  it('escapes the company name in the footer', async () => {
    const result = await dashboard.execute(
      { filename: 'x.html', data: { title: 'T' }, branding: { companyName: TAG } },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(fs.readFileSync(result.artifact!.path, 'utf8')).not.toMatch(/<img src=x/i)
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
    const html = fs.readFileSync(result.artifact!.path, 'utf8')
    expect(html).not.toMatch(/<img src=x/i)
    expect(html).toMatch(/&lt;img/i)
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

describe('escapeHtml', () => {
  it('escapes every character that can open markup or end an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;&#x2F;a&gt;'
    )
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })
})
