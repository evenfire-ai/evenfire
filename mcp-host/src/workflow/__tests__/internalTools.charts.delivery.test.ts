/**
 * How a chart reaches the next step: the arguments both paths accept, the name
 * it is saved under, and the size limits it is held to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolDefinition, InternalToolResult } from '../types'
import { workflowRouter as routerFor } from './support/workflowRouter'
import { zipEntries } from './support/zipEntries'

const chart = (): InternalToolDefinition =>
  INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_chart')!

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-chart-delivery-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

const workflowRouter = () => routerFor(outputDir)

/** Width and height from the PNG header. */
function pngSize(file: string): { width: number; height: number } {
  const header = fs.readFileSync(file).subarray(16, 24)
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) }
}

const yearly = {
  filename: 'revenue.png',
  type: 'bar',
  title: 'Revenue',
  data: { labels: [2023, 2024, 2025], datasets: [{ label: 'Revenue', data: [10, 14, 19] }] },
}

describe('numeric chart labels', () => {
  it('are accepted on the workflow path, which validates before rendering', async () => {
    const { result } = await workflowRouter().callTool('clerum__generate_chart', yearly)
    expect(result.isError).toBe(false)
    expect(fs.existsSync(path.join(outputDir, 'revenue.png'))).toBe(true)
  })
})

describe('point shapes', () => {
  const pairs = {
    filename: 'pairs.png',
    type: 'scatter',
    title: 'Pairs',
    data: {
      datasets: [
        {
          label: 'Run',
          data: [
            [1, 2],
            [2, 3],
          ],
        },
      ],
    },
  }

  it('accepts [x, y] pairs on both paths', async () => {
    const direct = await chart().execute(structuredClone(pairs), outputDir)
    expect(direct.success).toBe(true)
    const { result } = await workflowRouter().callTool('clerum__generate_chart', pairs)
    expect(result.isError).toBe(false)
    expect(fs.existsSync(path.join(outputDir, 'pairs.png'))).toBe(true)
  })

  it('draws {x, y} points on a line chart at their x', async () => {
    const result = await chart().execute(
      {
        filename: 'xy-line.png',
        type: 'line',
        title: 'XY',
        data: {
          datasets: [
            {
              data: [
                { x: 10, y: 2 },
                { x: 20, y: 3 },
              ],
            },
          ],
        },
      },
      outputDir
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('{x, y}')
    expect(result.content).not.toContain('numbered')
  })
})

describe('chaining a chart into a document', () => {
  it('tells the model to pass the saved file name, not a path it cannot know', async () => {
    const description = chart().description
    expect(description).not.toMatch(/file path under the output dir/)
    expect(description).toMatch(/file name/)

    const result = (await chart().execute(yearly, outputDir)) as InternalToolResult
    expect(result.content).toContain("images: [{ path: 'revenue.png' }]")
  })

  it('embeds by that name in a PDF on both paths', async () => {
    await chart().execute(yearly, outputDir)
    const pdf = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pdf')!
    const args = { filename: 'report.pdf', body: 'Revenue', images: [{ path: 'revenue.png' }] }

    const chat = await pdf.execute(args, outputDir)
    expect(chat.success).toBe(true)
    expect(chat.content ?? '').not.toMatch(/not found/)

    const { result } = await workflowRouter().callTool('clerum__generate_pdf', args)
    expect(result.isError).toBe(false)
  })

  it('names the per-sheet field for XLSX, which has no top-level images', async () => {
    expect(chart().description).toMatch(/sheets\[\]\.images\[\]\.path to the XLSX generator/)
    expect(chart().description).not.toMatch(/PDF, DOCX or XLSX generator/)

    const result = (await chart().execute(yearly, outputDir)) as InternalToolResult
    expect(result.content).toContain("sheets[].images: [{ path: 'revenue.png' }] to the XLSX")
    expect(result.content).not.toContain('PDF, DOCX or XLSX generator')
  })

  it('embeds by that name in an XLSX sheet on both paths', async () => {
    await chart().execute(yearly, outputDir)
    const xlsx = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_xlsx')!
    const sheet = { name: 'Data', rows: [['2025', 19]], images: [{ path: 'revenue.png' }] }
    const media = (file: string) =>
      [...zipEntries(path.join(outputDir, file)).keys()].filter(n => /^xl\/media\/.+\.png$/.test(n))

    const chat = await xlsx.execute({ filename: 'chat.xlsx', sheets: [sheet] }, outputDir)
    expect(chat.success).toBe(true)
    expect(media('chat.xlsx')).toHaveLength(1)

    const { result } = await workflowRouter().callTool('clerum__generate_xlsx', {
      filename: 'workflow.xlsx',
      sheets: [sheet],
    })
    expect(result.isError).toBe(false)
    expect(media('workflow.xlsx')).toHaveLength(1)
  })
})

describe('chart names', () => {
  it('replaces a file of the same name, which later steps embed by that name', async () => {
    const router = workflowRouter()
    await router.callTool('clerum__generate_chart', yearly)
    const { result } = await router.callTool('clerum__generate_chart', yearly)
    expect(result.isError).toBe(false)
    expect(fs.readdirSync(outputDir)).toEqual(['revenue.png'])
  })

  it('keeps non-Latin names apart and long names ending in .png', async () => {
    const a = await chart().execute({ ...yearly, filename: '销售报告' }, outputDir)
    const b = await chart().execute({ ...yearly, filename: '财务报告' }, outputDir)
    const long = await chart().execute({ ...yearly, filename: 'a'.repeat(250) }, outputDir)
    expect(a.artifact?.name).not.toBe(b.artifact?.name)
    for (const r of [a, b, long]) expect(r.artifact?.name).toMatch(/^[A-Za-z0-9._-]+\.png$/)
    expect(fs.readdirSync(outputDir)).toHaveLength(3)
  })
})

describe('chart options', () => {
  it('ignores a decimals value outside 0 to 20 with a note, instead of failing', async () => {
    const result = await chart().execute({ ...yearly, decimals: -1 }, outputDir)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('decimals -1 is not a whole number from 0 to 20')
  })
})

describe('chart size limits', () => {
  it('draws the large sizes the schema advertises on an empty folder', async () => {
    const result = await chart().execute({ ...yearly, width: 2000, height: 1700 }, outputDir)
    expect(result.success).toBe(true)
    const size = pngSize(result.artifact!.path)
    // Drawn below the 2x density to stay within the canvas budget, but never below 1x.
    expect(size.width).toBeGreaterThanOrEqual(2000)
    expect(size.width).toBeLessThanOrEqual(4000)
    expect(size.width / size.height).toBeCloseTo(2000 / 1700, 2)
  })

  it('reports the pixel size of the PNG it wrote', async () => {
    const result = await chart().execute({ ...yearly, width: 2000, height: 1700 }, outputDir)
    const size = pngSize(result.artifact!.path)
    expect(result.content).toContain(`(${size.width}x${size.height} px,`)
  })

  it('says when a width or height was out of range and what was drawn instead', async () => {
    const result = await chart().execute({ ...yearly, width: 1e9, height: 1 }, outputDir)
    expect(result.success).toBe(true)
    expect(result.content).toContain('width 1000000000 is over the 4000 maximum')
    expect(result.content).toContain('height 1 is under the 100 minimum')
    const size = pngSize(result.artifact!.path)
    expect(size.width / size.height).toBeCloseTo(4000 / 100, 1)
  })

  it('charges the quota for the PNG written, not for the canvas it was drawn on', async () => {
    const prev = process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
    process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1'
    try {
      const result = await chart().execute({ ...yearly, width: 1600, height: 900 }, outputDir)
      expect(result.success).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
      else process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = prev
    }
  })

  it('refuses a canvas over the pixel budget with a message that says what to change', async () => {
    const result = await chart().execute({ ...yearly, width: 4000, height: 4000 }, outputDir)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Chart too large.*Reduce width or height/)
    expect(result.error).not.toMatch(/quota/i)
  })
})
