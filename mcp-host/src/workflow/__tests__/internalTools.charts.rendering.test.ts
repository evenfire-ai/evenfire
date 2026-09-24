/**
 * Rendering assertions for clerum__generate_chart. These tests read the rendered
 * pixels, since a blank canvas still passes success and PNG-magic checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { Chart } from 'chart.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolDefinition } from '../types'

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-chart-render-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

interface Region {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Count pixels that differ from the chart's background. Used to assert that
 * something was actually drawn in a region, rather than trusting a success flag.
 */
async function inkIn(file: string, region?: Region): Promise<number> {
  const image = await loadImage(fs.readFileSync(file))
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const r = region ?? { x: 0, y: 0, w: image.width, h: image.height }
  const data = ctx.getImageData(r.x, r.y, r.w, r.h).data
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    // The light theme paints #ffffff; anything appreciably darker is drawn.
    if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) n++
  }
  return n
}

/** Count only strongly dark pixels: a filled mark, never a gridline. */
async function darkIn(file: string, region: Region): Promise<number> {
  const image = await loadImage(fs.readFileSync(file))
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(region.x, region.y, region.w, region.h).data
  let n = 0
  for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100) n++
  return n
}

/** RGBA pixels of a PNG. */
async function pixelsOf(
  file: string
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const image = await loadImage(fs.readFileSync(file))
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  return {
    data: ctx.getImageData(0, 0, image.width, image.height).data,
    width: image.width,
    height: image.height,
  }
}

/** Height of the first run of inked rows from the top: the title's text. */
async function titleHeight(file: string): Promise<{ rows: number; height: number }> {
  const { data, width, height } = await pixelsOf(file)
  const inked = (y: number): boolean => {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) return true
    }
    return false
  }
  let y = 0
  while (y < height && !inked(y)) y++
  const top = y
  while (y < height && inked(y)) y++
  return { rows: y - top, height }
}

/** Pixels within `tolerance` of `hex` in each channel, inside a region. */
function colorCount(
  image: { data: Uint8ClampedArray; width: number },
  hex: string,
  region: Region,
  tolerance = 12
): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  let n = 0
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = (y * image.width + x) * 4
      if (
        Math.abs(image.data[i] - r) <= tolerance &&
        Math.abs(image.data[i + 1] - g) <= tolerance &&
        Math.abs(image.data[i + 2] - b) <= tolerance
      ) {
        n++
      }
    }
  }
  return n
}

async function dimensions(file: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(fs.readFileSync(file))
  return { width: image.width, height: image.height }
}

const BAR_ARGS = {
  type: 'bar',
  data: {
    labels: ['Q1', 'Q2', 'Q3', 'Q4'],
    datasets: [{ label: 'Revenue', data: [120, 190, 300, 250] }],
  },
}

describe('chart text actually renders', () => {
  it('draws the title, which an image with no fonts silently omitted', async () => {
    const tool = findTool('clerum__generate_chart')

    // Two titles of different length over an identical plot: the longer one
    // must leave more ink in the title band. Comparing against an untitled
    // chart would not isolate the text, because dropping the title also lets
    // the plot area grow into the same band.
    const shortTitle = await tool.execute(
      { ...BAR_ARGS, filename: 'short.png', title: 'Q' },
      outputDir
    )
    const longTitle = await tool.execute(
      { ...BAR_ARGS, filename: 'long.png', title: 'Quarterly Revenue By Region And Segment' },
      outputDir
    )
    expect(shortTitle.success).toBe(true)
    expect(longTitle.success).toBe(true)

    const band = { x: 0, y: 0, w: 1600, h: 56 }
    const short = await inkIn(path.join(outputDir, 'short.png'), band)
    const long = await inkIn(path.join(outputDir, 'long.png'), band)
    expect(long).toBeGreaterThan(short)
    expect(short).toBeGreaterThan(50)
  })

  it('draws tick labels in the axis gutter', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute({ ...BAR_ARGS, filename: 'ticks.png' }, outputDir)
    expect(r.success).toBe(true)

    const { width, height } = await dimensions(path.join(outputDir, 'ticks.png'))
    // Bottom strip carries the category labels (Q1..Q4) and nothing else.
    const ink = await inkIn(path.join(outputDir, 'ticks.png'), {
      x: 0,
      y: height - 40,
      w: width,
      h: 38,
    })
    expect(ink).toBeGreaterThan(100)
  })

  it('prints the values on the bars by default', async () => {
    const tool = findTool('clerum__generate_chart')
    await tool.execute({ ...BAR_ARGS, filename: 'labels-on.png' }, outputDir)
    await tool.execute({ ...BAR_ARGS, filename: 'labels-off.png', showValues: false }, outputDir)

    const on = await inkIn(path.join(outputDir, 'labels-on.png'))
    const off = await inkIn(path.join(outputDir, 'labels-off.png'))
    expect(on).toBeGreaterThan(off)
  })

  it('renders legible text on a dark theme', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      { ...BAR_ARGS, filename: 'dark.png', title: 'Dark theme', theme: 'dark' },
      outputDir
    )
    expect(r.success).toBe(true)
    const image = await loadImage(fs.readFileSync(path.join(outputDir, 'dark.png')))
    const canvas = createCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    // Light text on the dark ground: pixels brighter than the #0f172a
    // background must exist in the title band, or the title is invisible.
    const data = ctx.getImageData(0, 0, image.width, 60).data
    let light = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] > 150) light++
    expect(light).toBeGreaterThan(100)
  })

  it('keeps radial tick and point labels visible on a dark radar', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'radar.png',
        type: 'radar',
        theme: 'dark',
        data: { labels: ['Speed', 'Power', 'Range'], datasets: [{ label: 'M', data: [5, 8, 3] }] },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    const image = await loadImage(fs.readFileSync(path.join(outputDir, 'radar.png')))
    const canvas = createCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, image.width, image.height).data
    let light = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200) light++
    expect(light).toBeGreaterThan(200)
  })

  it('prints the reading inside a gauge and keeps the dial on the canvas', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'gauge.png',
        type: 'gauge',
        gaugeMax: 200,
        data: { labels: ['v'], datasets: [{ label: 'G', data: [140] }] },
      },
      outputDir
    )
    expect(r.success).toBe(true)

    const file = path.join(outputDir, 'gauge.png')
    const { width, height } = await dimensions(file)
    // The readout sits in the middle of the dial.
    const centre = await inkIn(file, {
      x: Math.floor(width * 0.35),
      y: Math.floor(height * 0.6),
      w: Math.floor(width * 0.3),
      h: Math.floor(height * 0.3),
    })
    expect(centre).toBeGreaterThan(100)

    // The half circle must not run off the bottom edge.
    const bottomRow = await inkIn(file, { x: 0, y: height - 2, w: width, h: 2 })
    expect(bottomRow).toBe(0)
  })
})

describe('chart geometry', () => {
  it('reports the pixel size it actually wrote', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      { ...BAR_ARGS, filename: 'sized.png', width: 600, height: 300 },
      outputDir
    )
    expect(r.success).toBe(true)
    const { width, height } = await dimensions(path.join(outputDir, 'sized.png'))
    // Rasterized above the nominal size for print sharpness; the result message
    // states the real dimensions so callers embedding it are not misled.
    expect(r.content).toContain(`${width}x${height}`)
    expect(width).toBeGreaterThanOrEqual(600)
    expect(height).toBeGreaterThanOrEqual(300)
  })

  it('keeps category names on the axis of a horizontal bar', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'hbar.png',
        type: 'horizontalBar',
        data: {
          labels: ['Alpha Division', 'Beta Group'],
          datasets: [{ label: 'Spend', data: [512000, 318000] }],
        },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    const { height } = await dimensions(path.join(outputDir, 'hbar.png'))
    // Left gutter carries the category names, not their indices.
    const gutter = await inkIn(path.join(outputDir, 'hbar.png'), {
      x: 0,
      y: 0,
      w: 200,
      h: height,
    })
    expect(gutter).toBeGreaterThan(200)
  })

  it('shows a legend naming the slices of a pie', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'pie.png',
        type: 'pie',
        data: {
          labels: ['Compute', 'Storage', 'Network'],
          datasets: [{ label: 'USD', data: [268, 120, 64] }],
        },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    // A single-dataset slice chart carries its series names in `labels`, so the
    // legend has to key off those or the slices go unnamed.
    const band = await inkIn(path.join(outputDir, 'pie.png'), { x: 0, y: 40, w: 1600, h: 50 })
    expect(band).toBeGreaterThan(100)
  })
})

describe('legend of a single series', () => {
  const render = async (name: string, extra: Record<string, unknown>) => {
    const r = await findTool('clerum__generate_chart').execute(
      {
        filename: name,
        type: 'bar',
        data: { labels: ['A', 'B'], datasets: [{ label: 'Units sold', data: [3, 5] }] },
        ...extra,
      },
      outputDir
    )
    expect(r.success, r.error).toBe(true)
    return fs.readFileSync(path.join(outputDir, name))
  }

  it('is shown when the series name says what the titles do not', async () => {
    const byDefault = await render('a.png', { title: 'Q3' })
    expect(byDefault.equals(await render('b.png', { title: 'Q3', showLegend: true }))).toBe(true)
  })

  it('is left out when a title already names the series', async () => {
    const byDefault = await render('c.png', { title: 'Units sold by region' })
    const hidden = await render('d.png', { title: 'Units sold by region', showLegend: false })
    expect(byDefault.equals(hidden)).toBe(true)
  })
})

describe('legibility regressions found in QA', () => {
  it('keeps small magnitudes from collapsing to zero', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'tiny.png',
        type: 'line',
        title: 'Small decimals',
        data: {
          labels: ['A', 'B', 'C'],
          datasets: [{ label: 'rate', data: [0.0012, 0.0031, 0.0024] }],
        },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    // Small values keep enough decimals to differ from "0", so the axis gutter
    // carries more ink than three zeroes would.
    const { height } = await dimensions(path.join(outputDir, 'tiny.png'))
    const gutter = await inkIn(path.join(outputDir, 'tiny.png'), { x: 0, y: 0, w: 130, h: height })
    expect(gutter).toBeGreaterThan(400)
  })

  it('caps the width of a bar when there is only one category', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'one.png',
        type: 'bar',
        title: 'One value',
        data: { labels: ['Only'], datasets: [{ label: 'x', data: [42] }] },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    const file = path.join(outputDir, 'one.png')
    const { width, height } = await dimensions(file)
    // A lone bar is capped in width. Counting only the bar's own fill —
    // gridlines cross this strip too — that region must stay clear.
    const strip = await darkIn(file, {
      x: Math.round(width * 0.12),
      y: Math.round(height * 0.5),
      w: Math.round(width * 0.06),
      h: Math.round(height * 0.3),
    })
    expect(strip).toBe(0)
  })

  it('draws overlapping radar series so both stay visible', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'radar2.png',
        type: 'radar',
        title: 'Two profiles',
        data: {
          labels: ['Speed', 'Cost', 'Scale', 'Support'],
          datasets: [
            { label: 'Us', data: [9, 9, 9, 9] },
            { label: 'Them', data: [3, 3, 3, 3] },
          ],
        },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    const image = await loadImage(fs.readFileSync(path.join(outputDir, 'radar2.png')))
    const canvas = createCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    // The inner series sits entirely under the outer one. With an opaque fill
    // the centre is a single flat colour; a translucent fill leaves the two
    // regions measurably different.
    const centre = ctx.getImageData(
      Math.round(image.width / 2) - 6,
      Math.round(image.height / 2) - 6,
      12,
      12
    ).data
    const mid = ctx.getImageData(
      Math.round(image.width / 2) - 6,
      Math.round(image.height * 0.2),
      12,
      12
    ).data
    const avg = (d: Uint8ClampedArray): number => {
      let n = 0
      for (let i = 0; i < d.length; i += 4) n += d[i] + d[i + 1] + d[i + 2]
      return n / (d.length / 4)
    }
    expect(Math.abs(avg(centre) - avg(mid))).toBeGreaterThan(5)
  })

  it('labels the steps of a waterfall, which carry floating-bar values', async () => {
    const tool = findTool('clerum__generate_chart')
    await tool.execute(
      {
        filename: 'wf-on.png',
        type: 'waterfall',
        data: {
          labels: ['Open', 'New', 'Churn'],
          datasets: [{ label: 'D', data: [820, 210, -140] }],
        },
      },
      outputDir
    )
    await tool.execute(
      {
        filename: 'wf-off.png',
        type: 'waterfall',
        showValues: false,
        data: {
          labels: ['Open', 'New', 'Churn'],
          datasets: [{ label: 'D', data: [820, 210, -140] }],
        },
      },
      outputDir
    )
    const on = await inkIn(path.join(outputDir, 'wf-on.png'))
    const off = await inkIn(path.join(outputDir, 'wf-off.png'))
    expect(on).toBeGreaterThan(off)
  })

  it('thins value labels instead of stacking them into a band', async () => {
    const tool = findTool('clerum__generate_chart')
    const many = Array.from({ length: 60 }, (_, i) => 100 + i)
    const r = await tool.execute(
      {
        filename: 'dense.png',
        type: 'line',
        title: 'Sixty readings',
        data: {
          labels: Array.from({ length: 60 }, (_, i) => `D${i + 1}`),
          datasets: [{ label: 'v', data: many }],
        },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    const dense = await inkIn(path.join(outputDir, 'dense.png'))
    const few = await tool.execute(
      {
        filename: 'sparse.png',
        type: 'line',
        title: 'Sixty readings',
        showValues: false,
        data: {
          labels: Array.from({ length: 60 }, (_, i) => `D${i + 1}`),
          datasets: [{ label: 'v', data: many }],
        },
      },
      outputDir
    )
    expect(few.success).toBe(true)
    const sparse = await inkIn(path.join(outputDir, 'sparse.png'))
    // At this density labels are suppressed entirely, so the two must match.
    expect(Math.abs(dense - sparse)).toBeLessThan(dense * 0.02)
  })

  it('keeps every mark and label inside the canvas', async () => {
    const tool = findTool('clerum__generate_chart')
    for (const [name, args] of [
      [
        'edge-tiny',
        {
          type: 'line',
          data: { labels: ['A', 'B'], datasets: [{ label: 'r', data: [0.0012, 0.0031] }] },
        },
      ],
      [
        'edge-gauge',
        {
          type: 'gauge',
          gaugeMax: 100,
          data: { labels: ['v'], datasets: [{ label: 'g', data: [88] }] },
        },
      ],
      [
        'edge-hbar',
        {
          type: 'horizontalBar',
          data: { labels: ['A', 'B'], datasets: [{ label: 'x', data: [1000000, 20] }] },
        },
      ],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await tool.execute({ ...args, filename: `${name}.png`, title: name }, outputDir)
      expect(r.success).toBe(true)
      const file = path.join(outputDir, `${name}.png`)
      const { width, height } = await dimensions(file)
      const frame =
        (await inkIn(file, { x: 0, y: 0, w: width, h: 1 })) +
        (await inkIn(file, { x: 0, y: height - 1, w: width, h: 1 })) +
        (await inkIn(file, { x: 0, y: 0, w: 1, h: height })) +
        (await inkIn(file, { x: width - 1, y: 0, w: 1, h: height }))
      expect(frame).toBe(0)
    }
  })
})

describe('large canvases', () => {
  it('sizes type to the canvas, so a large chart reads like the default scaled up', async () => {
    const tool = findTool('clerum__generate_chart')
    const args = { ...BAR_ARGS, title: 'Quarterly revenue' }
    expect((await tool.execute({ ...args, filename: 'base.png' }, outputDir)).success).toBe(true)
    const big = await tool.execute(
      { ...args, filename: 'big.png', width: 4000, height: 2000 },
      outputDir
    )
    expect(big.success).toBe(true)
    const base = await titleHeight(path.join(outputDir, 'base.png'))
    const large = await titleHeight(path.join(outputDir, 'big.png'))
    // The title takes the same share of the image height, within a margin.
    const share = (t: { rows: number; height: number }) => t.rows / t.height
    expect(share(large)).toBeGreaterThan(share(base) * 0.75)
    expect(share(large)).toBeLessThan(share(base) * 1.33)
  }, 20_000)
})

describe('gauge readout', () => {
  it('prints the real value and says so when it is past gaugeMax', async () => {
    const tool = findTool('clerum__generate_chart')
    const over = await tool.execute(
      { filename: 'over.png', type: 'gauge', gaugeMax: 50, data: { datasets: [{ data: [72] }] } },
      outputDir
    )
    const full = await tool.execute(
      { filename: 'full.png', type: 'gauge', gaugeMax: 50, data: { datasets: [{ data: [50] }] } },
      outputDir
    )
    expect(over.success).toBe(true)
    expect(full.success).toBe(true)
    expect(over.content).toContain('72')
    expect(over.content).toContain('gaugeMax 50')
    expect(over.content).not.toContain('labels')
    // The dial is full in both; only the printed number differs.
    const a = await pixelsOf(path.join(outputDir, 'over.png'))
    const b = await pixelsOf(path.join(outputDir, 'full.png'))
    let differ = 0
    for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) differ++
    expect(differ).toBeGreaterThan(50)
  })

  it('says when a negative reading leaves the dial empty', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      { filename: 'neg.png', type: 'gauge', data: { datasets: [{ data: [-5] }] } },
      outputDir
    )
    expect(r.success).toBe(true)
    expect(r.content).toContain('-5')
    expect(r.content).toContain('below 0')
  })
})

describe('colors follow their points', () => {
  it('keeps each funnel stage in the color it was sent with', async () => {
    const tool = findTool('clerum__generate_chart')
    const red = '#dc2626'
    const green = '#16a34a'
    const r = await tool.execute(
      {
        filename: 'funnel-colors.png',
        type: 'funnel',
        showValues: false,
        data: {
          labels: ['Paid', 'Visits', 'Signups'],
          datasets: [{ data: [2400, 10000, 5000], backgroundColor: [red, green, '#f59e0b'] }],
        },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    const image = await pixelsOf(path.join(outputDir, 'funnel-colors.png'))
    const third = Math.floor(image.height / 3)
    const top = { x: 0, y: 0, w: image.width, h: third }
    const bottom = { x: 0, y: 2 * third, w: image.width, h: third }
    // Sorted descending, Visits is drawn first (top) and Paid last (bottom).
    expect(colorCount(image, green, top)).toBeGreaterThan(colorCount(image, red, top))
    expect(colorCount(image, red, bottom)).toBeGreaterThan(colorCount(image, green, bottom))
  })

  it('fills a short color list from the theme instead of repeating it', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'short-colors.png',
        type: 'pie',
        data: {
          labels: ['A', 'B', 'C', 'D'],
          datasets: [{ data: [1, 1, 1, 1], backgroundColor: ['#16a34a', '#f59e0b'] }],
        },
      },
      outputDir
    )
    expect(r.success).toBe(true)
    expect(r.content).toContain('backgroundColor')
    const image = await pixelsOf(path.join(outputDir, 'short-colors.png'))
    const all = { x: 0, y: 0, w: image.width, h: image.height }
    // Two of four equal slices each: repeating the list doubles every count.
    const green = colorCount(image, '#16a34a', all, 4)
    const amber = colorCount(image, '#f59e0b', all, 4)
    expect(Math.abs(green - amber)).toBeLessThan(green * 0.2)
    const slice = image.width * image.height * 0.02
    expect(green).toBeLessThan(slice * 10)
    expect(green).toBeGreaterThan(slice)
  })
})

describe('axes and points', () => {
  interface Drawn {
    scales: Record<string, { min: number; max: number }>
    datasets: Array<{ pointRadius?: unknown; clip?: unknown }>
    /** Per axis: its tick values, and the pixels from each end of the plot to a value. */
    axes: Record<
      string,
      { ticks: number[]; fromStart(v: number): number; fromEnd(v: number): number }
    >
  }

  /** The scales and datasets of the chart `args` draws, as Chart.js drew them. */
  async function drawn(args: Record<string, unknown>): Promise<Drawn> {
    const seen: Drawn[] = []
    const draw = Chart.prototype.draw
    const spy = vi.spyOn(Chart.prototype, 'draw').mockImplementation(function (this: Chart) {
      const area = this.chartArea
      seen.push({
        scales: Object.fromEntries(
          Object.entries(this.scales).map(([id, s]) => [id, { min: s.min, max: s.max }])
        ),
        datasets: this.data.datasets as Drawn['datasets'],
        axes: Object.fromEntries(
          Object.entries(this.scales).map(([id, s]) => {
            const pixel = s.getPixelForValue.bind(s)
            const [start, end] = s.isHorizontal()
              ? [area.left, area.right]
              : [area.bottom, area.top]
            return [
              id,
              {
                ticks: s.ticks.map(t => t.value),
                fromStart: (v: number) => Math.abs(pixel(v) - start),
                fromEnd: (v: number) => Math.abs(end - pixel(v)),
              },
            ]
          })
        ),
      })
      return draw.call(this)
    })
    try {
      const r = await findTool('clerum__generate_chart').execute(args, outputDir)
      expect(r.success, r.error).toBe(true)
    } finally {
      spy.mockRestore()
    }
    return seen[seen.length - 1]
  }

  const labels = ['Jan', 'Feb', 'Mar', 'Apr']

  it('keeps headroom past the data without taking values from 0 below zero', async () => {
    const rising = await drawn({
      filename: 'l.png',
      type: 'line',
      data: { labels, datasets: [{ label: 'Users', data: [0, 40, 75, 100] }] },
    })
    expect(rising.scales.y.min).toBe(0)
    expect(rising.scales.y.max).toBeGreaterThan(100)
    const falling = await drawn({
      filename: 'n.png',
      type: 'bar',
      data: { labels, datasets: [{ label: 'P&L', data: [-10, -40, -75, -100] }] },
    })
    expect(falling.scales.y.max).toBe(0)
    expect(falling.scales.y.min).toBeLessThan(-100)
    const mixed = await drawn({
      filename: 'm.png',
      type: 'line',
      data: { labels, datasets: [{ label: 'Change', data: [-30, 40, -75, 100] }] },
    })
    expect(mixed.scales.y.min).toBeLessThan(-75)
    expect(mixed.scales.y.max).toBeGreaterThan(100)
  })

  it('keeps the ticks of a scatter on its data and draws the points on the edge whole', async () => {
    const chart = await drawn({
      filename: 's.png',
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'A',
            data: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
              { x: 5, y: 3 },
            ],
          },
        ],
      },
    })
    const { x, y } = chart.axes
    expect([x.ticks[0], x.ticks[x.ticks.length - 1]]).toEqual([0, 10])
    expect([y.ticks[0], y.ticks[y.ticks.length - 1]]).toEqual([0, 10])
    // A point of 6 px with half its 1 px border fits inside the plot.
    for (const axis of [x, y]) {
      expect(axis.fromStart(0)).toBeGreaterThan(6.49)
      expect(axis.fromEnd(10)).toBeGreaterThan(6.49)
    }
    expect(chart.datasets[0]).not.toHaveProperty('clip')
  })

  it('keeps a bubble whole inside the plot, and thins the ticks the room crowds', async () => {
    const chart = await drawn({
      filename: 'b.png',
      type: 'bubble',
      data: {
        datasets: [
          {
            label: 'B',
            data: [
              { x: 0, y: 0, r: 20 },
              { x: 10, y: 10, r: 20 },
            ],
          },
        ],
      },
    })
    for (const axis of Object.values(chart.axes)) {
      expect(axis.ticks[0]).toBe(0)
      expect(axis.fromStart(0)).toBeGreaterThan(20.49)
      expect(axis.fromEnd(10)).toBeGreaterThan(20.49)
    }
    const crowded = await drawn({
      filename: 'c.png',
      type: 'bubble',
      data: {
        datasets: [
          {
            label: 'B',
            data: [
              { x: 0, y: 0, r: 90 },
              { x: 50, y: 50, r: 90 },
            ],
          },
        ],
      },
    })
    // Room for a bubble past a quarter of the axis is not given; the ticks,
    // spaced for the whole axis, keep every other one.
    const y = crowded.axes.y
    expect(y.ticks).toEqual([0, 10, 20, 30, 40, 50])
    const gaps = y.ticks.slice(1).map((v, i) => y.fromStart(v) - y.fromStart(y.ticks[i]))
    expect(Math.min(...gaps)).toBeGreaterThan(15)
  })

  it('draws the points of a dense series smaller, so they do not merge', async () => {
    const points = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i % 50, y: i % 37 }))
    const sparse = await drawn({
      filename: 'a.png',
      type: 'scatter',
      data: { datasets: [{ label: 'A', data: points(20) }] },
    })
    const dense = await drawn({
      filename: 'b.png',
      type: 'scatter',
      data: { datasets: [{ label: 'A', data: points(3000) }] },
    })
    expect(sparse.datasets[0].pointRadius).toBe(6)
    expect(dense.datasets[0].pointRadius).toBe(1.5)
  })
})
