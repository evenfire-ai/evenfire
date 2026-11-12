// The ignored-arguments note names what a generator does not take, whatever
// the generator does with its arguments: copying or spreading an object reads
// every field of it, and must not hide one the output leaves out (H-4).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { prepared } from '../toolExecution'
import type { InternalToolDefinition, InternalToolResult } from '../types'

const IGNORED = /Ignored arguments this tool does not read: (.*)\.$/m

function ignoredIn(result: InternalToolResult): string[] {
  const match = IGNORED.exec(result.content ?? '')
  return match ? match[1].split(', ').map(name => name.replace(/^'|'$/g, '')) : []
}

/** A tool that renders `title` and `rows[].label` and copies everything it is given. */
function copyingTool(aliased: string[] = []): InternalToolDefinition {
  return prepared({
    name: 'clerum__generate_test',
    description: 'test',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        rows: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' } } },
        },
      },
    },
    execute: async args => {
      // Every field is read here, the undeclared ones too.
      JSON.stringify(args)
      const rows = (args.rows as Array<Record<string, unknown>>).map(row => ({ ...row }))
      return {
        success: true,
        content: `File generated: ${String(args.title)} (${rows.map(r => r.label).join(', ')})`,
        aliasedArguments: aliased,
      }
    },
  })
}

describe('arguments a generator does not take are named', () => {
  it('names an undeclared nested field the generator copies along with its sibling', async () => {
    const result = await copyingTool().execute(
      { title: 'T', rows: [{ label: 'a', color: 'red' }, { label: 'b' }], extra: 1 },
      '/unused'
    )
    expect(result.success).toBe(true)
    expect(ignoredIn(result)).toEqual(['rows[0].color', 'extra'])
  })

  it('names an undeclared nested field that has no copied sibling', async () => {
    const result = await copyingTool().execute({ title: 'T', rows: [{ color: 'red' }] }, '/unused')
    expect(ignoredIn(result)).toEqual(['rows[0].color'])
  })

  it('leaves out an argument the generator says it took under another name', async () => {
    const result = await copyingTool(['extra']).execute(
      { title: 'T', rows: [{ label: 'a', color: 'red' }], extra: 1 },
      '/unused'
    )
    expect(ignoredIn(result)).toEqual(['rows[0].color'])
    // The list stays inside mcp-host.
    expect(result).not.toHaveProperty('aliasedArguments')
  })
})

describe('generators that take an argument under another name', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-aliases-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const tool = (name: string) => INTERNAL_TOOLS.find(t => t.name === `clerum__generate_${name}`)!

  it('xlsx: places top-level images without naming them, and names a field of the copied sheet', async () => {
    await tool('chart').execute(
      { filename: 'c.png', type: 'bar', data: { labels: ['a'], datasets: [{ data: [1] }] } },
      dir
    )
    const result = await tool('xlsx').execute(
      {
        filename: 'a.xlsx',
        sheets: [{ name: 'S', rows: [['a'], [1]], freeze: true }],
        images: ['c.png'],
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(path.join(dir, 'a.xlsx'))).toBe(true)
    expect(result.content).toContain('placed on the first sheet')
    expect(ignoredIn(result)).toEqual(['sheets[0].freeze'])
  })

  it('pptx: reads a template field under its snake-case name and a team member as a KPI card', async () => {
    const result = await tool('pptx').execute(
      {
        filename: 'p.pptx',
        template: 'pitch-deck',
        data: {
          company: 'Acme',
          tagline: 't',
          problem: 'p',
          solution: 's',
          market_size: { value: 1000 },
          team: [{ label: 'Ana', value: 'CEO', photo: 'ana.png' }],
        },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(path.join(dir, 'p.pptx'))).toBe(true)
    expect(result.content).toContain('data.market_size was read as data.marketSize')
    expect(ignoredIn(result)).toEqual(['data.team[0].photo'])
  })

  it('pptx: names a KPI-card field a team member sends beside its own name', async () => {
    const result = await tool('pptx').execute(
      {
        filename: 'q.pptx',
        template: 'pitch-deck',
        data: {
          company: 'Acme',
          tagline: 't',
          problem: 'p',
          solution: 's',
          team: [{ name: 'Ana', role: 'CEO', label: 'unused' }],
        },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(ignoredIn(result)).toEqual(['data.team[0].label'])
  })

  it('dashboard: reads services listed under items with their fields, and names one it does not show', async () => {
    const result = await tool('dashboard').execute(
      {
        filename: 'd.html',
        template: 'custom',
        data: {
          title: 'T',
          blocks: [
            {
              type: 'service-health',
              items: [{ name: 'API', status: 'healthy', metric: '42 ms', owner: 'ops' }],
            },
            { type: 'kpis', items: [{ label: 'R', value: 1, sparkline: [1, 2, 3] }] },
          ],
        },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(path.join(dir, 'd.html'))).toBe(true)
    expect(result.content).toContain('the list was read from items')
    expect(ignoredIn(result)).toEqual(['data.blocks[0].items[0].owner'])
  })
})
