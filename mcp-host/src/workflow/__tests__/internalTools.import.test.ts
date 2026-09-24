/**
 * Importing the generators changes nothing process-wide: Chart.js keeps its
 * defaults until a chart is drawn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Chart } from 'chart.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CHART_FONT_STACK } from '../fonts'
import { INTERNAL_TOOLS } from '../internalTools'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-import-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

describe('importing the generators', () => {
  it('leaves the Chart.js defaults as they were until a chart is drawn', async () => {
    const { family } = Chart.defaults.font
    const { color } = Chart.defaults
    expect(family).not.toBe(CHART_FONT_STACK)

    const chart = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_chart')!
    const r = await chart.execute(
      { filename: 'c.png', type: 'bar', data: { labels: ['a'], datasets: [{ data: [1] }] } },
      outputDir
    )
    expect(r.success, r.error).toBe(true)
    expect(Chart.defaults.font.family).toBe(CHART_FONT_STACK)
    expect(Chart.defaults.color).not.toBe(color)
  })
})
