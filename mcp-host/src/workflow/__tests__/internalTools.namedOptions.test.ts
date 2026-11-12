/**
 * Templates, themes and palettes are chosen by name. A name that is not one of
 * them falls back to the default, and the result says so: a model that sent
 * "blue" learns it was not used instead of receiving the light theme silently.
 * Case does not matter, so "Dark" is dark.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'

const tool = (name: string) => INTERNAL_TOOLS.find(t => t.name === `clerum__generate_${name}`)!

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-named-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const chart = {
  filename: 'c.png',
  chartType: 'bar',
  data: { labels: ['a'], datasets: [{ label: 'x', data: [1] }] },
}

describe('names that pick an option', () => {
  it('reports a chart theme it does not know and draws the light one', async () => {
    const result = await tool('chart').execute({ ...chart, theme: 'blue' }, dir)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('theme "blue" is not one of')
    expect(result.content).toContain('"light" was used')
  })

  it('takes a chart theme in any case', async () => {
    const result = await tool('chart').execute({ ...chart, theme: 'Dark' }, dir)
    expect(result.success, result.error).toBe(true)
    expect(result.content ?? '').not.toContain('theme')
  })

  it.each([
    ['pdf', { body: 'Text.' }],
    ['docx', { body: 'Text.' }],
    ['xlsx', { sheets: [{ name: 'S', rows: [['a'], [1]] }] }],
  ])('reports a %s palette it does not know', async (name, args) => {
    const result = await tool(name).execute(
      { filename: `p.${name}`, palette: 'neon', ...args },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('palette "neon" is not one of')
  })

  it('reports a dashboard template and theme it does not know, and reads a mode in any case', async () => {
    const result = await tool('dashboard').execute(
      {
        filename: 'd.html',
        template: 'nope',
        theme: 'Corporate',
        defaultThemeMode: 'Dark',
        data: { title: 'T', kpis: [{ label: 'A', value: '1' }] },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('template "nope" is not one of')
    expect(result.content).not.toContain('theme "Corporate"')
    expect(result.content ?? '').not.toContain('defaultThemeMode')
    const html = fs.readFileSync(result.artifact!.path, 'utf8')
    // A fixed mode replaces following the viewer's setting.
    expect(html).not.toContain('@media (prefers-color-scheme: dark)')
  })

  it('reports a dashboard mode that is neither light nor dark', async () => {
    const result = await tool('dashboard').execute(
      {
        filename: 'd.html',
        defaultThemeMode: 'purple',
        data: { title: 'T', kpis: [{ label: 'A', value: '1' }] },
      },
      dir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('defaultThemeMode "purple" is not light or dark')
  })
})
