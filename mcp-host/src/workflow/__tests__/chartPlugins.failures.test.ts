/**
 * Value labels and the gauge reading are drawn after the chart itself, so a
 * failure there must not cost the image; it must not go unnoticed either. The
 * chart is still saved, and the result says what is missing from it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'

vi.mock('../chartPlugins', async importOriginal => {
  const actual = await importOriginal<typeof import('../chartPlugins')>()
  // Options whose field throws when read: the plugin's own drawing code fails,
  // and its own catch is what runs.
  const failing = <T extends object>(options: T, field: string): T =>
    Object.defineProperty({ ...options }, field, {
      get() {
        throw new Error('canvas lost')
      },
    })
  return {
    ...actual,
    valueLabelsPlugin: (o: Parameters<typeof actual.valueLabelsPlugin>[0]) =>
      actual.valueLabelsPlugin(failing(o, 'fontScale')),
    gaugeCenterPlugin: (o: Parameters<typeof actual.gaugeCenterPlugin>[0]) =>
      actual.gaugeCenterPlugin(failing(o, 'textColor')),
  }
})

let chart: (typeof INTERNAL_TOOLS)[number]
beforeAll(() => {
  chart = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_chart')!
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-chart-fail-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a decoration that fails to draw', () => {
  it('keeps the chart and says the value labels are missing', async () => {
    const result = await chart.execute(
      {
        filename: 'c.png',
        type: 'bar',
        showValues: true,
        data: { labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, 2] }] },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(result.artifact!.path)).toBe(true)
    expect(result.content).toContain('drawn without value labels (canvas lost)')
  })

  it('keeps the gauge and says its reading is missing', async () => {
    const result = await chart.execute(
      {
        filename: 'g.png',
        type: 'gauge',
        gaugeMax: 100,
        data: { datasets: [{ label: 'value', data: [42] }] },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('drawn without the gauge reading (canvas lost)')
  })
})
