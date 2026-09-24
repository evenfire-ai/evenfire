/**
 * Intrinsic-size reading and aspect-preserving fitting of embedded images.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS, fitImageBox, imageDisplaySize, imageIntrinsicSize } from '../internalTools'
import type { InternalToolDefinition } from '../types'
import { withPngDensity } from './support/pngDensity'
import { zipEntryText } from './support/zipEntries'

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-img-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function makeChart(filename: string, width: number, height: number): Promise<string> {
  const r = await findTool('clerum__generate_chart').execute(
    {
      filename,
      type: 'bar',
      title: 'Chart',
      width,
      height,
      data: { labels: ['A', 'B'], datasets: [{ label: 's', data: [1, 2] }] },
    },
    outputDir
  )
  expect(r.success).toBe(true)
  return path.join(outputDir, filename)
}

describe('imageIntrinsicSize', () => {
  it('reads a PNG header', async () => {
    const file = await makeChart('c.png', 800, 400)
    const size = imageIntrinsicSize(file)
    expect(size).toBeDefined()
    expect(size!.width / size!.height).toBeCloseTo(2, 5)
  })

  it('returns undefined for a file it cannot read', () => {
    expect(imageIntrinsicSize(path.join(outputDir, 'missing.png'))).toBeUndefined()
    const junk = path.join(outputDir, 'junk.png')
    fs.writeFileSync(junk, 'not an image')
    expect(imageIntrinsicSize(junk)).toBeUndefined()
  })
})

describe('imageDisplaySize', () => {
  it('shows a PNG at the density it declares, up to 1200 dpi', async () => {
    const file = await makeChart('c.png', 800, 400)
    const stored = imageIntrinsicSize(file)!
    // 600 dpi: 23622 pixels a metre, against 3780 at 96 dpi.
    fs.writeFileSync(file, withPngDensity(fs.readFileSync(file), 23622))
    const ratio = 23622 / 3780
    expect(imageDisplaySize(file)).toEqual({
      width: Math.round(stored.width / ratio),
      height: Math.round(stored.height / ratio),
    })
  })

  it('ignores a density no picture is shown at, instead of shrinking it to nothing', async () => {
    const file = await makeChart('c.png', 800, 400)
    const stored = imageIntrinsicSize(file)!
    fs.writeFileSync(file, withPngDensity(fs.readFileSync(file), 0xffffffff))
    expect(imageDisplaySize(file)).toEqual(stored)
    const r = await findTool('clerum__generate_docx').execute(
      { filename: 'd.docx', body: 'x', images: ['c.png'] },
      outputDir
    )
    expect(r.success, r.error).toBe(true)
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(
      zipEntryText(r.artifact!.path, 'word/document.xml')
    )!
    expect(Number(extent[1])).toBeGreaterThan(9525 * 100)
    expect(Number(extent[2])).toBeGreaterThan(9525 * 50)
  })
})

describe('fitImageBox', () => {
  it('keeps the aspect ratio when neither side is given', async () => {
    const file = await makeChart('wide.png', 800, 400)
    const box = fitImageBox(file, { width: 560, height: 380 })
    expect(box.width / box.height).toBeCloseTo(2, 1)
    expect(box.width).toBeLessThanOrEqual(560)
    expect(box.height).toBeLessThanOrEqual(380)
  })

  it('derives the other side from an explicit width', async () => {
    const file = await makeChart('w.png', 800, 400)
    const box = fitImageBox(file, { width: 560, height: 380 }, { width: 400 })
    expect(box.width).toBe(400)
    expect(box.height).toBe(200)
  })

  it('derives the other side from an explicit height', async () => {
    const file = await makeChart('h.png', 800, 400)
    const box = fitImageBox(file, { width: 560, height: 380 }, { height: 150 })
    expect(box.height).toBe(150)
    expect(box.width).toBe(300)
  })

  it('reads a width and height given together as a box, keeping proportions', async () => {
    const file = await makeChart('both.png', 800, 400)
    expect(fitImageBox(file, { width: 560, height: 380 }, { width: 300, height: 300 })).toEqual({
      width: 300,
      height: 150,
    })
  })

  it('fits a tall image without exceeding the box', async () => {
    const file = await makeChart('tall.png', 400, 900)
    const box = fitImageBox(file, { width: 560, height: 380 })
    expect(box.height).toBeLessThanOrEqual(380)
    expect(box.width).toBeLessThanOrEqual(560)
    expect(box.width / box.height).toBeCloseTo(400 / 900, 1)
  })

  it('falls back to the box when the file carries no readable size', () => {
    const junk = path.join(outputDir, 'x.png')
    fs.writeFileSync(junk, 'nope')
    expect(fitImageBox(junk, { width: 500, height: 300 })).toEqual({ width: 500, height: 300 })
  })
})

describe('documents embed charts undistorted', () => {
  it('writes a docx carrying the chart', async () => {
    await makeChart('chart.png', 800, 400)
    const r = await findTool('clerum__generate_docx').execute(
      { filename: 'r.docx', title: 'Report', body: 'Body.', images: [{ path: 'chart.png' }] },
      outputDir
    )
    expect(r.success).toBe(true)
    expect(fs.statSync(path.join(outputDir, 'r.docx')).size).toBeGreaterThan(1000)
  })

  it('writes an xlsx carrying the chart', async () => {
    await makeChart('chart.png', 800, 400)
    const r = await findTool('clerum__generate_xlsx').execute(
      {
        filename: 'r.xlsx',
        sheets: [
          {
            name: 'Data',
            headers: ['A'],
            rows: [[1]],
            images: [{ path: 'chart.png', anchor: 'C2' }],
          },
        ],
      },
      outputDir
    )
    expect(r.success).toBe(true)
    expect(fs.statSync(path.join(outputDir, 'r.xlsx')).size).toBeGreaterThan(1000)
  })
})
