/**
 * Names a model sends are looked up in fixed tables: colours, number formats,
 * palettes, themes, block types. A name such as "constructor" or "toString" is
 * also a key every object inherits, so each table must answer only for its own
 * entries, or a function lands where a colour or a palette was expected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { zipEntryText } from './support/zipEntries'

const tool = (name: string) => INTERNAL_TOOLS.find(t => t.name === `clerum__generate_${name}`)!
const LEAKED = /native code|\[object Object\]|function Object\(\)/

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-prototype-keys-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('names that every object inherits', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'xlsx reads %s as no colour, format or palette',
    async word => {
      const result = await tool('xlsx').execute(
        {
          filename: 'p.xlsx',
          palette: word,
          sheets: [
            {
              name: 'S',
              rows: [['Amount'], [1], [2]],
              titleRow: { text: 'T', fillColor: word, fontColor: word },
              columnFormats: { Amount: word },
              conditionalFormatting: [
                { column: 'Amount', rules: [{ equals: 1, fillColor: word, fontColor: word }] },
              ],
            },
          ],
        },
        dir
      )
      expect(result.success, result.error).toBe(true)
      const styles = await zipEntryText(result.artifact!.path, 'xl/styles.xml')
      expect(styles).not.toMatch(LEAKED)
    }
  )

  it.each([
    ['pdf', { body: 'Text.' }],
    ['docx', { body: 'Text.' }],
    ['pptx', { slides: [{ layout: 'title-bullets', title: 'T', bullets: ['a'] }] }],
  ])('%s takes an inherited palette name as an unknown one', async (name, args) => {
    for (const word of ['constructor', 'toString', '__proto__']) {
      const result = await tool(name).execute(
        { filename: `p.${name}`, palette: word, ...args },
        dir
      )
      expect(result.success, `${word}: ${result.error}`).toBe(true)
    }
  })

  it('draws a chart whose theme is an inherited name with a known theme', async () => {
    for (const theme of ['constructor', 'toString', '__proto__']) {
      const result = await tool('chart').execute(
        {
          filename: 'c.png',
          chartType: 'bar',
          theme,
          data: { labels: ['a'], datasets: [{ label: 'x', data: [1] }] },
        },
        dir
      )
      expect(result.success, `${theme}: ${result.error}`).toBe(true)
    }
  })

  it('reports a dashboard block whose type is an inherited name as unknown', async () => {
    const result = await tool('dashboard').execute(
      {
        filename: 'd.html',
        template: 'custom',
        data: {
          title: 'T',
          blocks: [{ type: 'constructor' }, { type: 'kpis', items: [{ label: 'A', value: '1' }] }],
        },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    const html = fs.readFileSync(result.artifact!.path, 'utf8')
    expect(html).not.toMatch(LEAKED)
    expect(result.content).toContain('data.blocks[0].type "constructor" is not a block type')
  })
})
