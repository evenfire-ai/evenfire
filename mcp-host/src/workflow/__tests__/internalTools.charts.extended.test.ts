import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolDefinition } from '../types'

let testOutputDir: string

beforeEach(() => {
  testOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-chart-ext-test-'))
})

afterEach(() => {
  fs.rmSync(testOutputDir, { recursive: true, force: true })
})

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found`)
  return tool
}

// PNGs start with the 8-byte signature 89 50 4E 47 0D 0A 1A 0A.
function isPngFile(p: string): boolean {
  if (!fs.existsSync(p)) return false
  const fd = fs.openSync(p, 'r')
  const buf = Buffer.alloc(8)
  fs.readSync(fd, buf, 0, 8, 0)
  fs.closeSync(fd)
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
}

describe('clerum__generate_chart — extended chart types', () => {
  it('renders a bubble chart from {x,y,r} object data', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'bubble.png',
        type: 'bubble',
        title: 'Customers',
        data: {
          datasets: [
            {
              label: 'A',
              data: [
                { x: 1, y: 5, r: 10 },
                { x: 3, y: 9, r: 18 },
                { x: 5, y: 7, r: 14 },
              ],
            },
          ],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPngFile(path.join(testOutputDir, 'bubble.png'))).toBe(true)
  })

  it('renders a stackedBar with stacked scales option', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'sb.png',
        type: 'stackedBar',
        data: {
          labels: ['Q1', 'Q2'],
          datasets: [
            { label: 'NA', data: [10, 15] },
            { label: 'EU', data: [8, 9] },
          ],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPngFile(path.join(testOutputDir, 'sb.png'))).toBe(true)
  })

  it('renders a stackedArea (line + fill stacking)', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'sa.png',
        type: 'stackedArea',
        data: {
          labels: ['W1', 'W2', 'W3'],
          datasets: [
            { label: 'Free', data: [100, 120, 140] },
            { label: 'Pro', data: [20, 25, 32] },
          ],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPngFile(path.join(testOutputDir, 'sa.png'))).toBe(true)
  })

  it('renders a mixedBarLine (first dataset = bar, rest = line)', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'mix.png',
        type: 'mixedBarLine',
        data: {
          labels: ['Jan', 'Feb', 'Mar'],
          datasets: [
            { label: 'Revenue', data: [20, 25, 28] },
            { label: 'Target', data: [24, 24, 24] },
          ],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPngFile(path.join(testOutputDir, 'mix.png'))).toBe(true)
  })

  it('renders a gauge from a single value with gaugeMax', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'gauge.png',
        type: 'gauge',
        title: 'SLA',
        gaugeMax: 100,
        data: { datasets: [{ label: 'value', data: [87] }] },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPngFile(path.join(testOutputDir, 'gauge.png'))).toBe(true)
  })

  it('clamps gauge value to [0, gaugeMax]', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'gauge-clamp.png',
        type: 'gauge',
        gaugeMax: 100,
        // Out-of-range value: tool should clamp to 100, not crash.
        data: { datasets: [{ label: 'v', data: [9999] }] },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
  })

  it('renders a waterfall with positive/negative coloring + total bar', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'water.png',
        type: 'waterfall',
        title: 'Revenue Bridge',
        data: {
          labels: ['Open', 'New', 'Expansion', 'Churn'],
          datasets: [{ label: 'Δ', data: [50, 12, 8, -6] }],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPngFile(path.join(testOutputDir, 'water.png'))).toBe(true)
  })

  it('sorts funnel data descending and renders horizontally', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'funnel.png',
        type: 'funnel',
        title: 'Funnel',
        data: {
          // Out-of-order on purpose; the tool sorts these descending.
          labels: ['Activate', 'Visit', 'Trial', 'Convert'],
          datasets: [{ label: 'Users', data: [1200, 10000, 2400, 600] }],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPngFile(path.join(testOutputDir, 'funnel.png'))).toBe(true)
  })

  it('rejects an unsupported chart type with a clear error', async () => {
    const tool = findTool('clerum__generate_chart')
    const r = await tool.execute(
      {
        filename: 'bad.png',
        type: 'sankey',
        data: { labels: ['a'], datasets: [{ label: 'a', data: [1] }] },
      },
      testOutputDir
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unsupported chart type/)
  })
})

// ─── PPTX presentation templates ───────────────────────────────────

describe('clerum__generate_pptx — presentation templates', () => {
  function isPptx(p: string): boolean {
    if (!fs.existsSync(p)) return false
    const fd = fs.openSync(p, 'r')
    const b = Buffer.alloc(4)
    fs.readSync(fd, b, 0, 4, 0)
    fs.closeSync(fd)
    return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
  }

  it('builds an executive-brief deck from typed data', async () => {
    const tool = findTool('clerum__generate_pptx')
    const r = await tool.execute(
      {
        filename: 'eb.pptx',
        template: 'executive-brief',
        data: {
          title: 'Q1 Brief',
          subtitle: 'Short executive readout',
          status: 'green',
          kpis: [
            { label: 'Revenue', value: '$120K', delta: '+12%', deltaDirection: 'up' },
            { label: 'Churn', value: '2.1%', delta: '-0.3pp', deltaDirection: 'up' },
          ],
          takeaways: ['Revenue beat plan', 'Churn down for the third week'],
          nextSteps: ['Ship pricing experiment', 'Hire two AEs'],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPptx(path.join(testOutputDir, 'eb.pptx'))).toBe(true)
  })

  it('builds a quarterly-review deck with revenue + breakdown + table', async () => {
    const tool = findTool('clerum__generate_pptx')
    const r = await tool.execute(
      {
        filename: 'qr.pptx',
        template: 'quarterly-review',
        data: {
          title: 'Q1 2026 Review',
          period: 'Q1 2026',
          status: 'yellow',
          highlights: ['Revenue +12%', 'NPS 64'],
          kpis: [{ label: 'Revenue', value: '$120K' }],
          revenueChart: {
            type: 'line',
            labels: ['Jan', 'Feb', 'Mar'],
            datasets: [{ label: 'MRR', data: [40, 45, 50] }],
          },
          breakdownChart: {
            type: 'doughnut',
            labels: ['NA', 'EU', 'APAC'],
            datasets: [{ label: 'Revenue', data: [60, 30, 10] }],
          },
          metricsTable: {
            headers: ['Metric', 'Value'],
            rows: [
              ['Revenue', '$120K'],
              ['Churn', '2.1%'],
            ],
          },
          outlook: ['Land 2 enterprise deals', 'Launch self-serve'],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPptx(path.join(testOutputDir, 'qr.pptx'))).toBe(true)
  })

  it('builds an incident-review deck with severity → status mapping', async () => {
    const tool = findTool('clerum__generate_pptx')
    const r = await tool.execute(
      {
        filename: 'ir.pptx',
        template: 'incident-review',
        data: {
          title: 'INC-2026-04 — Login outage',
          date: '2026-04-12',
          severity: 'high',
          summary: 'Login was unavailable for 38 minutes due to a JWT key rotation race.',
          timelineTable: {
            headers: ['Time', 'Event'],
            rows: [
              ['09:02', 'First failure observed'],
              ['09:14', 'Oncall paged'],
              ['09:40', 'Mitigation applied'],
            ],
          },
          impact: ['~12% of traffic affected', 'Zero data loss'],
          rootCause: 'Stale public key cached after rotation; refresh interval was 1h.',
          remediation: ['Cut refresh interval to 5m', 'Add health check on JWT validation path'],
          lessons: ['Key rotation needs an automated post-deploy verification step'],
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPptx(path.join(testOutputDir, 'ir.pptx'))).toBe(true)
  })

  it('builds a pitch-deck with problem / solution / market / ask', async () => {
    const tool = findTool('clerum__generate_pptx')
    const r = await tool.execute(
      {
        filename: 'pd.pptx',
        template: 'pitch-deck',
        data: {
          company: 'Acme',
          tagline: 'Better mousetraps for the 21st century',
          problem: 'Mousetraps haven’t innovated in a hundred years.',
          solution: 'AI-driven, humane, recyclable — a new category.',
          marketSize: { value: '$8B', description: 'Global pest-control TAM' },
          team: [
            { label: 'CEO', value: 'Jane Doe' },
            { label: 'CTO', value: 'Sam Lee' },
          ],
          ask: {
            amount: '$3M seed',
            useOfFunds: ['Hire engineers', 'Field trials', '12-month runway'],
          },
        },
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPptx(path.join(testOutputDir, 'pd.pptx'))).toBe(true)
  })

  it('rejects template without data with a clear error', async () => {
    const tool = findTool('clerum__generate_pptx')
    const r = await tool.execute(
      { filename: 'no-data.pptx', template: 'executive-brief' },
      testOutputDir
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/requires.*data/i)
  })

  it('falls back to slides[] when template is "custom" or absent', async () => {
    const tool = findTool('clerum__generate_pptx')
    const r = await tool.execute(
      {
        filename: 'custom.pptx',
        slides: [{ layout: 'cover', title: 'Custom mode', subtitle: 'Backwards compatible' }],
      },
      testOutputDir
    )
    expect(r.success).toBe(true)
    expect(isPptx(path.join(testOutputDir, 'custom.pptx'))).toBe(true)
  })
})
