import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { StepMcpRouter } from '../stepRouter'
import type { InternalToolDefinition } from '../types'

let testOutputDir: string

beforeEach(() => {
  testOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-pptx-test-'))
})

afterEach(() => {
  fs.rmSync(testOutputDir, { recursive: true, force: true })
})

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found`)
  return tool
}

// All produced .pptx are zip archives — sanity check the magic header so we
// don't accept a truncated or text file as valid output.
function isPptxFile(p: string): boolean {
  if (!fs.existsSync(p)) return false
  const fd = fs.openSync(p, 'r')
  const buf = Buffer.alloc(4)
  fs.readSync(fd, buf, 0, 4, 0)
  fs.closeSync(fd)
  return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

// ─── Tool registration ─────────────────────────────────────────────

describe('clerum__generate_pptx — registration', () => {
  it('is registered in INTERNAL_TOOLS', () => {
    const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pptx')
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/PowerPoint|pptx/i)
    expect(tool!.parameters).toBeDefined()
  })
})

// ─── Basic generation ──────────────────────────────────────────────

describe('clerum__generate_pptx — basic generation', () => {
  it('creates a valid .pptx with cover + bullets', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'basic.pptx',
        title: 'Basic Test',
        slides: [
          {
            layout: 'cover',
            title: 'Quarterly Review',
            subtitle: 'Q1 numbers',
            status: 'green',
          },
          {
            layout: 'title-bullets',
            title: 'Highlights',
            bullets: ['Revenue +12%', 'Churn down 3pp', 'NPS 64'],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(result.artifact?.format).toBe('pptx')
    expect(isPptxFile(path.join(testOutputDir, 'basic.pptx'))).toBe(true)
  })

  it('rejects empty slides array with a clear error', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute({ filename: 'empty.pptx', slides: [] }, testOutputDir)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/non-empty/)
  })

  it('appends .pptx extension if missing', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'no-ext',
        slides: [{ layout: 'title-bullets', title: 't', bullets: ['a'] }],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(testOutputDir, 'no-ext.pptx'))).toBe(true)
  })

  it('does NOT double-extension when caller supplies .pptx already', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'good.pptx',
        slides: [{ layout: 'title-bullets', title: 't', bullets: ['a'] }],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(testOutputDir, 'good.pptx'))).toBe(true)
    expect(fs.existsSync(path.join(testOutputDir, 'good.pptx.pptx'))).toBe(false)
  })
})

// ─── All slide layouts render without throwing ──────────────────────

describe('clerum__generate_pptx — all slide layouts', () => {
  it('renders cover, section, title-bullets, kpis, title-table, two-column, quote', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'all-layouts.pptx',
        title: 'Layout Coverage',
        palette: 'corporate',
        slides: [
          { layout: 'cover', title: 'Layouts', subtitle: 'Coverage test', status: 'yellow' },
          { layout: 'section', title: 'Section A', eyebrow: 'Part 1', subtitle: 'Intro' },
          { layout: 'title-bullets', title: 'Bullets', bullets: ['one', 'two', 'three'] },
          {
            layout: 'kpis',
            title: 'KPIs',
            kpis: [
              { label: 'Revenue', value: '$20K', delta: '+12%', deltaDirection: 'up' },
              { label: 'Cost', value: '$5K', delta: '-3%', deltaDirection: 'down' },
              { label: 'Subs', value: 44, delta: '0', deltaDirection: 'neutral' },
            ],
          },
          {
            layout: 'title-table',
            title: 'Metrics',
            table: {
              headers: ['Metric', 'Value', 'Δ'],
              rows: [
                ['Rev', '$20K', '+12%'],
                ['Cost', '$5K', '-3%'],
              ],
            },
          },
          {
            layout: 'two-column',
            title: 'Pros / Cons',
            columns: {
              left: { type: 'bullets', bullets: ['Fast', 'Cheap'] },
              right: { type: 'narrative', text: 'On the other hand...' },
            },
          },
          {
            layout: 'quote',
            quote: { text: 'Quality is a habit.', attribution: 'Aristotle' },
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(isPptxFile(path.join(testOutputDir, 'all-layouts.pptx'))).toBe(true)
    // 7 slides + their content => non-trivial size.
    expect(result.artifact!.sizeBytes).toBeGreaterThan(40_000)
  })

  it('rejects a malformed layout via AJV when dispatched through stepRouter', async () => {
    const router = new StepMcpRouter(() => {
      throw new Error('factory not used')
    })
    router.registerInternalTools(INTERNAL_TOOLS, testOutputDir)

    const { result } = await router.callTool('clerum__generate_pptx', {
      filename: 'bad.pptx',
      slides: [{ layout: 'not-a-real-layout', title: 'x' }],
    })
    expect(result.isError).toBe(true)
    const content = result.content as { error?: string }
    expect(content.error).toMatch(/Invalid arguments/i)
  })
})

// ─── Security: path traversal on logoPath / image / chart ──────────

describe('clerum__generate_pptx — path traversal protection', () => {
  it('silently skips logo when logoPath is traversal-unsafe', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'logo-trav.pptx',
        branding: { logoPath: '../../../etc/passwd' },
        slides: [{ layout: 'cover', title: 'X', subtitle: 'Y' }],
      },
      testOutputDir
    )
    // Render still succeeds — bad logoPath is dropped, deck is produced.
    expect(result.success).toBe(true)
    expect(isPptxFile(path.join(testOutputDir, 'logo-trav.pptx'))).toBe(true)
  })

  it('silently skips slide image when image.path is traversal-unsafe', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'img-trav.pptx',
        slides: [
          {
            layout: 'image',
            title: 'Bad image',
            image: { path: '/etc/shadow', caption: 'Will be skipped' },
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(isPptxFile(path.join(testOutputDir, 'img-trav.pptx'))).toBe(true)
  })

  it('silently skips chart PNG when chart.path is traversal-unsafe', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'chart-trav.pptx',
        slides: [
          {
            layout: 'title-chart',
            title: 'Bad chart',
            chart: { path: '../../../tmp/anything.png', caption: 'skipped' },
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(isPptxFile(path.join(testOutputDir, 'chart-trav.pptx'))).toBe(true)
  })
})

// ─── Native chart embedding ────────────────────────────────────────

describe('clerum__generate_pptx — native chart embedding', () => {
  it('embeds a native pptx bar chart from labels + datasets', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'native-chart.pptx',
        slides: [
          {
            layout: 'title-chart',
            title: 'Sales by Region',
            chart: {
              type: 'bar',
              labels: ['NA', 'EU', 'APAC'],
              datasets: [{ label: 'Q1', data: [120, 90, 60] }],
            },
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(isPptxFile(path.join(testOutputDir, 'native-chart.pptx'))).toBe(true)
  })

  it('renders chart from PNG path produced by clerum__generate_chart', async () => {
    const chartTool = findTool('clerum__generate_chart')
    const chartResult = await chartTool.execute(
      {
        filename: 'sales.png',
        type: 'line',
        data: {
          labels: ['M1', 'M2', 'M3'],
          datasets: [{ label: 'Sales', data: [10, 20, 15] }],
        },
      },
      testOutputDir
    )
    expect(chartResult.success).toBe(true)
    const chartPath = path.join(testOutputDir, 'sales.png')

    const pptxTool = findTool('clerum__generate_pptx')
    const result = await pptxTool.execute(
      {
        filename: 'png-chart.pptx',
        slides: [
          {
            layout: 'title-chart',
            title: 'Sales',
            chart: { path: chartPath, caption: 'From clerum__generate_chart' },
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(isPptxFile(path.join(testOutputDir, 'png-chart.pptx'))).toBe(true)
  })
})

// ─── Quota enforcement ──────────────────────────────────────────────

describe('clerum__generate_pptx — quota enforcement', () => {
  it('rejects when projected size exceeds quota', async () => {
    const tool = findTool('clerum__generate_pptx')
    // enforceQuota parses MB as integer, so we set a 1 MB cap and
    // pre-fill the directory with ~950 KB of bytes so any pptx write
    // pushes us past the limit.
    const prev = process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
    process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1'
    // 1 MB = 1,048,576 bytes. Pre-fill > quota so even a tiny pptx exceeds.
    fs.writeFileSync(path.join(testOutputDir, 'filler.bin'), Buffer.alloc(1_100_000))
    try {
      const result = await tool.execute(
        {
          filename: 'big.pptx',
          slides: [{ layout: 'title-bullets', title: 't', bullets: ['a'] }],
        },
        testOutputDir
      )
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/quota/i)
    } finally {
      if (prev === undefined) delete process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
      else process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = prev
    }
  })
})

// ─── Speaker notes ─────────────────────────────────────────────────

describe('clerum__generate_pptx — speaker notes', () => {
  it('attaches notes without crashing the writer', async () => {
    const tool = findTool('clerum__generate_pptx')
    const result = await tool.execute(
      {
        filename: 'notes.pptx',
        slides: [
          {
            layout: 'title-bullets',
            title: 'With notes',
            bullets: ['point'],
            notes: 'Detailed speaker notes for this slide go here.',
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
  })
})
