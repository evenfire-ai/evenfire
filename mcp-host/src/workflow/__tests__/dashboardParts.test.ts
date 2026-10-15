/**
 * The dashboard's parts tested apart from the tool: chart cards, and the
 * helpers that put model text into HTML and into the page script.
 */
import { describe, expect, it } from 'vitest'
import { DashboardCharts } from '../dashboardCharts'
import { escapeHtml, escapeHtmlAttr, oneOf, safeJsonForScript } from '../dashboardHtml'

const notes = () => ({ warnings: [] as string[], failures: [] as string[] })
const bar = { type: 'bar', labels: ['a', 'b'], datasets: [{ label: 's', data: [1, '1,200'] }] }

describe('DashboardCharts', () => {
  it('keeps the spec of a chart the page draws, and a canvas for it', () => {
    const charts = new DashboardCharts(true, notes())
    const html = charts.card(bar, 'data.charts[0]', { title: 'Sales' })
    expect(html).toContain('<h3 class="chart-card__title">Sales</h3>')
    expect(html).toContain('<canvas id="chart-0"')
    expect(charts.specs).toHaveLength(1)
    expect(charts.drawn).toBe(1)
  })

  it('shows the values as a table when the page draws no charts', () => {
    const charts = new DashboardCharts(false, notes())
    const html = charts.card(bar, 'data.charts[0]')
    expect(html).not.toContain('<canvas')
    // The values as read: "1,200" sent as text is the number 1200.
    expect(html).toContain('<td>b</td><td>1200</td>')
    expect(charts.specs).toHaveLength(0)
    expect(charts.drawn).toBe(1)
  })

  it('keeps the colors of values placed by their labels, and colors a gap without a warning', () => {
    const reported = notes()
    const charts = new DashboardCharts(true, reported)
    charts.card(
      {
        type: 'bar',
        labels: ['Jan', 'Feb', 'Mar'],
        datasets: [
          {
            label: 's',
            data: [
              { label: 'Feb', value: 20 },
              { label: 'Jan', value: 10 },
            ],
            backgroundColor: ['red', 'green'],
          },
        ],
      },
      'data.charts[0]'
    )
    const ds = charts.specs[0].datasets[0]
    expect(ds.data).toEqual([10, 20, null])
    const colors = ds.backgroundColor as string[]
    expect(colors.slice(0, 2)).toEqual(['green', 'red'])
    expect(typeof colors[2]).toBe('string')
    expect(reported.warnings.join(' ')).not.toContain('not a CSS color')
  })

  it.each(['waterfall', 'funnel'])('%s: a dropped series adds no category', type => {
    const charts = new DashboardCharts(true, notes())
    charts.card(
      {
        type,
        datasets: [
          {
            label: 'Primary',
            data: [
              { label: 'Start', value: 2 },
              { label: 'Change', value: -1 },
            ],
          },
          { label: 'Second', data: [{ label: 'Phantom', value: 900 }] },
        ],
      },
      'data.charts[0]'
    )
    expect(charts.specs[0].labels).not.toContain('Phantom')
    // Witness: the kept series' own labels are there.
    expect(charts.specs[0].labels).toEqual(expect.arrayContaining(['Start', 'Change']))
  })

  it('reports a chart it cannot draw in its place, escaped', () => {
    const reported = notes()
    const charts = new DashboardCharts(true, reported)
    const html = charts.card({ type: '<b>pie3d</b>', labels: ['a'] }, 'data.charts[1]')
    expect(html).toContain('This chart could not be drawn')
    expect(html).not.toContain('<b>pie3d')
    expect(reported.failures).toHaveLength(1)
    expect(charts.drawn).toBe(0)
  })
})

describe('dashboardHtml', () => {
  it('escapes attributes as it escapes text', () => {
    expect(escapeHtmlAttr(`'"<a>`)).toBe(escapeHtml(`'"<a>`))
  })

  it('takes only an allowed value, and only a string', () => {
    expect(oneOf('dark', ['light', 'dark'] as const, 'light')).toBe('dark')
    expect(oneOf('toString', ['light', 'dark'] as const, 'light')).toBe('light')
    expect(oneOf(1, ['light', 'dark'] as const, 'light')).toBe('light')
  })

  it('writes JSON a script block cannot be closed or broken by', () => {
    const text = safeJsonForScript({ a: '</script><script>alert(1)</script>', b: '\u2028&' })
    expect(text).not.toMatch(/<|>|&|\u2028/)
    expect(JSON.parse(text)).toEqual({ a: '</script><script>alert(1)</script>', b: '\u2028&' })
  })
})
