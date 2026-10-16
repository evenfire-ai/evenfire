/**
 * Native charts: the chart cache must hold numbers, since PowerPoint drops
 * values written as text, and a type it cannot draw must be refused by name.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { chartCategories, chartValues, chartXmls, generatePptx, slideXml } from './support/pptxXml'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-pptx-chart-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function chartDeck(chart: Record<string, unknown>, title = 'Revenue') {
  const result = await generatePptx(
    { filename: 'c.pptx', slides: [{ layout: 'title-chart', title, chart }] },
    outputDir
  )
  const file = path.join(outputDir, 'c.pptx')
  return { result, charts: result.success ? chartXmls(file) : [], file }
}

describe('clerum__generate_pptx — native chart data is normalized', () => {
  it('reads numbers written as text', async () => {
    const { result, charts } = await chartDeck({
      type: 'bar',
      labels: ['A', 'B', 'C'],
      datasets: [{ label: 'S', data: ['12', '1,200', '$5M'] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(chartValues(charts[0])).toEqual([['12', '1200', '5000000']])
    expect(result.content).toMatch(/text/)
  })

  it('reads {label, value} records and takes their labels', async () => {
    const { result, charts } = await chartDeck({
      type: 'bar',
      datasets: [
        {
          label: 'S',
          data: [
            { label: 'North', value: 3 },
            { label: 'South', value: 5 },
          ],
        },
      ],
    })
    expect(result.success, result.error).toBe(true)
    expect(chartValues(charts[0])).toEqual([['3', '5']])
    expect(chartCategories(charts[0])).toEqual(['North', 'South'])
  })

  it('evens out labels and values of different lengths, and says so', async () => {
    const { result, charts } = await chartDeck({
      type: 'bar',
      labels: ['A', 'B', 'C', 'D'],
      datasets: [{ label: 'S', data: [1, 2, 3, 4, 5] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(chartCategories(charts[0])).toHaveLength(5)
    expect(result.content).toMatch(/slides\[0\]\.chart\.labels/)
  })

  it('accepts the data shape clerum__generate_chart takes', async () => {
    const { result, charts } = await chartDeck({
      type: 'line',
      data: { labels: ['a', 'b'], datasets: [{ label: 's', data: [1, 2] }] },
    })
    expect(result.success, result.error).toBe(true)
    expect(chartValues(charts[0])).toEqual([['1', '2']])
  })

  it('takes the labels given beside series nested under data', async () => {
    const { result, charts } = await chartDeck({
      type: 'bar',
      labels: ['Q1', 'Q2', 'Q3'],
      data: { datasets: [{ label: 'Revenue', data: [1, 2, 3] }] },
    })
    expect(result.success, result.error).toBe(true)
    expect(chartCategories(charts[0])).toEqual(['Q1', 'Q2', 'Q3'])
    expect(result.content).not.toMatch(/labels` was missing|Ignored arguments/)
  })

  it('rejects a nested category label that is not text or a number', async () => {
    const result = await generatePptx(
      {
        filename: 'q.pptx',
        template: 'quarterly-review',
        data: {
          title: 'Q3 review',
          period: 'Q3 2026',
          revenueChart: {
            type: 'bar',
            data: { labels: ['Q1', {}], datasets: [{ label: 'Revenue', data: [1, 2] }] },
          },
        },
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/data\.revenueChart\.data\.labels\[1\] must be text or a number/)
  })

  it('rejects a nested series name that is not text', async () => {
    const result = await generatePptx(
      {
        filename: 'q.pptx',
        template: 'quarterly-review',
        data: {
          title: 'Q3 review',
          period: 'Q3 2026',
          revenueChart: {
            type: 'bar',
            data: { labels: ['Q1', 'Q2'], datasets: [{ label: 5, data: [1, 2] }] },
          },
        },
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/data\.revenueChart\.data\.datasets\[0\]\.label must be text/)
  })

  it('rejects a series with no values, naming the field', async () => {
    const { result } = await chartDeck({ type: 'bar', labels: ['a'], datasets: [] })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/slides\[0\]\.chart\.datasets/)
  })

  it('refuses a type with no native form and says how to draw it', async () => {
    const { result } = await chartDeck({
      type: 'scatter',
      datasets: [{ label: 'S', data: [{ x: 1, y: 2 }] }],
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/slides\[0\]\.chart\.type/)
    expect(result.error).toMatch(/clerum__generate_chart/)
    expect(result.error).toMatch(/chart\.path/)
  })

  it('draws stackedBar as a stacked native bar chart', async () => {
    const { result, charts } = await chartDeck({
      type: 'stackedBar',
      labels: ['Q1', 'Q2'],
      datasets: [
        { label: 'A', data: [1, 2] },
        { label: 'B', data: [3, 4] },
      ],
    })
    expect(result.success, result.error).toBe(true)
    expect(charts[0]).toContain('<c:grouping val="stacked"/>')
  })

  it('says a pie cannot show a value below zero, naming the series', async () => {
    const { result } = await chartDeck({
      type: 'pie',
      labels: ['Loss', 'North', 'South'],
      datasets: [{ label: 'Result', data: [-10, 20, 30] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain(
      '`slides[0].chart.datasets[0]` has 1 value(s) below zero, which a pie cannot show'
    )
  })

  it('reports that a pie draws only its first series', async () => {
    const { result, charts } = await chartDeck({
      type: 'pie',
      labels: ['a', 'b'],
      datasets: [
        { label: 'A', data: [1, 2] },
        { label: 'B', data: [3, 4] },
      ],
    })
    expect(result.success, result.error).toBe(true)
    expect(chartValues(charts[0])).toEqual([['1', '2']])
    expect(result.content).toMatch(/pie/)
  })
})

describe('clerum__generate_pptx — native charts can be read without the data', () => {
  it('gives a pie a legend and percentage labels', async () => {
    const { result, charts } = await chartDeck({
      type: 'pie',
      labels: ['Subscriptions', 'Services', 'Hardware'],
      datasets: [{ label: 'Mix', data: [70, 20, 10] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(charts[0]).toContain('<c:legend>')
    expect(charts[0]).toMatch(/<c:showPercent val="1"\/>/)
  })

  it('prints the values on a short bar series', async () => {
    const { result, charts } = await chartDeck({
      type: 'bar',
      labels: ['A', 'B', 'C'],
      datasets: [{ label: 'S', data: [1200, 950, 700] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(charts[0]).toMatch(/<c:showVal val="1"\/>/)
  })

  it('does not repeat the slide title inside the chart', async () => {
    const { result, charts } = await chartDeck(
      {
        type: 'bar',
        title: 'Revenue',
        labels: ['A'],
        datasets: [{ label: 'S', data: [1] }],
      },
      'Revenue'
    )
    expect(result.success, result.error).toBe(true)
    expect(charts[0]).not.toContain('<c:title>')
  })

  it('sets the chart text in the deck font', async () => {
    const { result, charts, file } = await chartDeck({
      type: 'bar',
      title: 'Units',
      labels: ['A'],
      datasets: [{ label: 'S', data: [1] }],
    })
    expect(result.success, result.error).toBe(true)
    const faces = new Set([...charts[0].matchAll(/typeface="([^"]+)"/g)].map(m => m[1]))
    expect([...faces]).toEqual(['Arial'])
    expect(slideXml(file, 1)).toContain('<c:chart ')
  })
})

/** The `<c:catAx>` or `<c:valAx>` element of a chart part. */
function axis(chartXml: string, kind: 'catAx' | 'valAx'): string {
  const hit = new RegExp(`<c:${kind}>[\\s\\S]*?</c:${kind}>`).exec(chartXml)
  if (!hit) throw new Error(`chart has no ${kind}`)
  return hit[0]
}

describe('clerum__generate_pptx — native charts draw the values truthfully', () => {
  it.each(['bar', 'horizontalBar', 'stackedBar', 'area', 'stackedArea'])(
    'starts the value axis of a %s chart at zero when no value is negative',
    async type => {
      const { result, charts } = await chartDeck({
        type,
        labels: ['Jul', 'Aug', 'Sep'],
        datasets: [{ label: 'Revenue', data: [1320, 1405, 1475] }],
      })
      expect(result.success, result.error).toBe(true)
      expect(axis(charts[0], 'valAx')).toContain('<c:min val="0"/>')
    }
  )

  it('ends the value axis at zero when every value is negative', async () => {
    const { result, charts } = await chartDeck({
      type: 'bar',
      labels: ['Q1', 'Q2'],
      datasets: [{ label: 'Loss', data: [-120, -150] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(axis(charts[0], 'valAx')).toContain('<c:max val="0"/>')
    expect(axis(charts[0], 'valAx')).not.toContain('<c:min ')
  })

  it('leaves the axis of a line chart and of mixed signs to PowerPoint', async () => {
    const line = await chartDeck({
      type: 'line',
      labels: ['Jul', 'Aug'],
      datasets: [{ label: 'Revenue', data: [1320, 1405] }],
    })
    const mixed = await chartDeck({
      type: 'bar',
      labels: ['a', 'b'],
      datasets: [{ label: 'Change', data: [-2, 5] }],
    })
    for (const { result, charts } of [line, mixed]) {
      expect(result.success, result.error).toBe(true)
      expect(axis(charts[0], 'valAx')).not.toMatch(/<c:(min|max) /)
    }
  })

  it('lists horizontal bars top to bottom in the order given, with the value axis below', async () => {
    const { result, charts } = await chartDeck({
      type: 'horizontalBar',
      labels: ['1st: Alpha', '2nd: Beta', '3rd: Gamma', '4th: Delta'],
      datasets: [{ label: 'Score', data: [90, 70, 50, 30] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(axis(charts[0], 'catAx')).toContain('<c:orientation val="maxMin"/>')
    const valAx = axis(charts[0], 'valAx')
    expect(valAx).toContain('<c:crosses val="max"/>')
    expect(valAx).toContain('<c:tickLblPos val="nextTo"/>')
  })

  it('keeps the vertical bar category order unchanged', async () => {
    const { result, charts } = await chartDeck({
      type: 'bar',
      labels: ['a', 'b'],
      datasets: [{ label: 'S', data: [1, 2] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(axis(charts[0], 'catAx')).toContain('<c:orientation val="minMax"/>')
  })

  it('leaves a gap in a line where a value is missing', async () => {
    const { result, charts } = await chartDeck({
      type: 'line',
      labels: ['a', 'b', 'c', 'd', 'e'],
      datasets: [{ label: 'x', data: [5, 6, null, 8, 9] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(charts[0]).toContain('<c:dispBlanksAs val="gap"/>')
  })
})

describe('clerum__generate_pptx — value labels print each value as given', () => {
  async function labelFormat(data: number[]): Promise<string> {
    const { result, charts } = await chartDeck({
      type: 'bar',
      labels: data.map((_, i) => `c${i}`),
      datasets: [{ label: 'Revenue', data }],
    })
    expect(result.success, result.error).toBe(true)
    const dLbls = /<c:dLbls>[\s\S]*?<\/c:dLbls>/.exec(charts[0])![0]
    return /<c:numFmt formatCode="([^"]*)"/
      .exec(dLbls)![1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  }

  it('groups integers without a decimal point', async () => {
    expect(await labelFormat([1200, 5000000, 980])).toBe('#,##0')
  })

  it('does not add ".0" to the integers of a series with one small fraction', async () => {
    // PowerPoint renders this as "1,200", "5,000,000" and "980.5".
    expect(await labelFormat([1200, 5000000, 980.5])).toBe('[>=1000]#,##0;[<=-1000]-#,##0;General')
  })

  it('gives every label the same decimals when a grouped value has a fraction', async () => {
    expect(await labelFormat([1200, 1234.5])).toBe('#,##0.0')
    expect(await labelFormat([1200, 1234.56, 0.1 + 0.2])).toBe('#,##0.00')
  })
})
