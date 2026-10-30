/**
 * The dashboard repairs chart series the same way as the PNG generator.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function build(charts: unknown[]): Promise<string> {
  const r = await findTool('clerum__generate_dashboard').execute(
    { filename: 'd.html', data: { title: 'Review', charts } },
    outputDir
  )
  expect(r.success).toBe(true)
  return fs.readFileSync(path.join(outputDir, 'd.html'), 'utf8')
}

describe('dashboard chart data', () => {
  it('reads values written as text, as the PNG generator does', async () => {
    const html = await build([
      {
        type: 'bar',
        title: 'Text values',
        labels: ['A', 'B'],
        datasets: [{ label: 'x', data: ['1,200', '$3,400'] }],
      },
    ])
    expect(html).toContain('1200')
    expect(html).toContain('3400')
  })

  it('adopts labels out of {label, value} records', async () => {
    const html = await build([
      {
        type: 'bar',
        title: 'Records',
        datasets: [{ label: 'Spend', data: [{ label: 'Compute', value: 268 }] }],
      },
    ])
    expect(html).toContain('Compute')
    expect(html).toContain('268')
  })

  it('fails, naming the field, when the only chart is unusable', async () => {
    const r = await findTool('clerum__generate_dashboard').execute(
      {
        filename: 'd.html',
        data: {
          title: 'Review',
          charts: [{ type: 'bar', labels: ['A'], datasets: [{ label: 'x', data: [] }] }],
        },
      },
      outputDir
    )
    expect(r.success).toBe(false)
    expect(r.error).toContain('data.charts[0].datasets[0].data is empty')
    expect(fs.existsSync(path.join(outputDir, 'd.html'))).toBe(false)
  })

  it('keeps the rest of the dashboard when one chart is unusable', async () => {
    const html = await build([
      { type: 'bar', title: 'Broken', labels: ['A'], datasets: [{ label: 'x', data: [] }] },
      { type: 'bar', title: 'Fine', labels: ['A', 'B'], datasets: [{ label: 'x', data: [4, 7] }] },
    ])
    expect(html).toContain('Fine')
    expect(html).toContain('This chart could not be drawn')
    expect(html).toMatch(/needs at least one value/)
    expect(html).toMatch(/\[\s*4\s*,\s*7\s*\]/)
  })
})
