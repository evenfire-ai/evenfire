import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { unknownArguments, withoutUnsetNulls } from '../schemaArguments'

const schemaOf = (name: string) => INTERNAL_TOOLS.find(t => t.name === name)!.parameters

describe('withoutUnsetNulls', () => {
  it('drops null for optional arguments, as many models send them', () => {
    expect(
      withoutUnsetNulls(schemaOf('clerum__generate_pdf'), {
        filename: 'r.pdf',
        body: 'text',
        title: null,
        palette: null,
        branding: { companyName: null },
        tables: [{ headers: ['A'], rows: [['x', null]], layout: null }],
      })
    ).toEqual({
      filename: 'r.pdf',
      body: 'text',
      branding: {},
      tables: [{ headers: ['A'], rows: [['x', null]] }],
    })
  })

  it('keeps null for a required argument', () => {
    expect(
      withoutUnsetNulls(schemaOf('clerum__generate_pdf'), { filename: null, body: 'x' })
    ).toEqual({ filename: null, body: 'x' })
  })

  it('keeps a "__proto__" key an ordinary property', () => {
    const args = JSON.parse('{"filename":"r.md","content":"x","__proto__":{"polluted":true}}')
    const clean = withoutUnsetNulls(schemaOf('clerum__generate_markdown'), args) as Record<
      string,
      unknown
    >
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('unknownArguments', () => {
  it('names arguments the schema does not declare, at any depth', () => {
    expect(
      unknownArguments(schemaOf('clerum__generate_xlsx'), {
        filename: 'e.xlsx',
        title: 'Market',
        sheets: [{ name: 'S', columns: ['Month'], rows: [['Jan', 1]] }],
      })
    ).toEqual(['title', 'sheets[0].columns'])
  })

  it('leaves open maps alone', () => {
    expect(
      unknownArguments(schemaOf('clerum__generate_dashboard'), {
        filename: 'd.html',
        data: {
          title: 'T',
          tables: [{ headers: ['Status'], rows: [['ok']], columnTypes: { Status: 'severity' } }],
        },
      })
    ).toEqual([])
  })
})

describe('a generator called directly, as the chat path does', () => {
  it('runs a call whose optional arguments are null, without them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-null-args-'))
    try {
      const pdf = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pdf')!
      const result = await pdf.execute(
        { filename: 'n.pdf', body: 'text', title: null, palette: null, images: null },
        dir
      )
      expect(result.success, result.error).toBe(true)
      expect(result.content).not.toContain('Ignored arguments')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not call an argument ignored when the generator reads it under another name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-null-args-'))
    const tool = (name: string) => INTERNAL_TOOLS.find(t => t.name === `clerum__generate_${name}`)!
    try {
      await tool('chart').execute(
        { filename: 'c.png', type: 'bar', data: { labels: ['a'], datasets: [{ data: [1] }] } },
        dir
      )
      const results = [
        await tool('xlsx').execute(
          { filename: 'a.xlsx', sheets: [{ name: 'S', rows: [['a'], [1]] }], images: ['c.png'] },
          dir
        ),
        await tool('pptx').execute(
          {
            filename: 'a.pptx',
            template: 'pitch-deck',
            data: {
              company: 'Acme',
              tagline: 't',
              problem: 'p',
              solution: 's',
              market_size: { value: 1000 },
            },
          },
          dir
        ),
        await tool('dashboard').execute(
          {
            filename: 'd.html',
            template: 'custom',
            data: {
              title: 'T',
              blocks: [
                { type: 'service-health', items: [{ name: 'API', status: 'healthy' }] },
                { type: 'kpis', kpis: [{ label: 'R', value: 1 }] },
              ],
            },
          },
          dir
        ),
      ]
      for (const result of results) {
        expect(result.success, result.error).toBe(true)
        expect(result.content).toMatch(/was read|placed on the first sheet/)
        expect(result.content).not.toContain('Ignored arguments')
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the arguments it ignored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-null-args-'))
    try {
      const markdown = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_markdown')!
      const result = await markdown.execute(
        { filename: 'n.md', content: 'text', format: 'gfm' },
        dir
      )
      expect(result.success).toBe(true)
      expect(result.content).toContain("Ignored arguments this tool does not read: 'format'")
      expect(result.content?.match(/Notes: /g)).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
