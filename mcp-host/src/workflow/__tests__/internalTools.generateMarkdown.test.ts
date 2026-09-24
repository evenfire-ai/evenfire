/**
 * clerum__generate_markdown writes text or lines and refuses anything else, and
 * names in non-Latin scripts get distinct files.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { StepMcpRouter } from '../stepRouter'
import type { InternalToolResult } from '../types'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-md-tool-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

function run(args: Record<string, unknown>): Promise<InternalToolResult> {
  const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_markdown')!
  return tool.execute(args, outputDir)
}

describe('clerum__generate_markdown content', () => {
  it('joins an array of lines with newlines', async () => {
    const r = await run({ filename: 'a.md', content: ['# Title', '', 'para one'] })
    expect(r.success).toBe(true)
    expect(fs.readFileSync(r.artifact!.path, 'utf8')).toBe('# Title\n\npara one')
  })

  it('accepts the array form on the workflow path too', async () => {
    const router = new StepMcpRouter(() => {
      throw new Error('no MCP servers in this test')
    })
    router.registerInternalTools(INTERNAL_TOOLS, outputDir)
    const { result } = await router.callTool('clerum__generate_markdown', {
      filename: 'w.md',
      content: ['# Title', 'body'],
    })
    expect(result.isError).toBe(false)
    expect(fs.readFileSync(path.join(outputDir, 'w.md'), 'utf8')).toBe('# Title\nbody')
  })

  it.each([
    ['an object', { text: 'x' }, 'content must be the markdown text as a string'],
    ['a list holding an object', ['ok', { text: 'x' }], 'an array with entries that are not text'],
    ['nothing', undefined, 'content is required'],
    ['blank text', '  \n ', 'content is empty'],
  ])('refuses %s instead of writing a meaningless file', async (_label, content, message) => {
    const r = await run({ filename: 'bad.md', content })
    expect(r.success).toBe(false)
    expect(r.error).toContain(message)
    expect(fs.readdirSync(outputDir)).toEqual([])
  })
})

describe('clerum__generate_markdown filenames', () => {
  it('keeps two different non-Latin names in two files', async () => {
    const a = await run({ filename: '报告', content: 'A' })
    const b = await run({ filename: '总结', content: 'B' })
    expect(a.artifact!.name).not.toBe(b.artifact!.name)
    expect(fs.readFileSync(a.artifact!.path, 'utf8')).toBe('A')
    expect(fs.readFileSync(b.artifact!.path, 'utf8')).toBe('B')
  })

  it('keeps the extension on a long name and never writes a hidden file', async () => {
    const long = await run({ filename: 'a'.repeat(250), content: 'x' })
    expect(long.artifact!.name.endsWith('.md')).toBe(true)
    const empty = await run({ filename: '', content: 'x' })
    expect(empty.artifact!.name).toBe('output.md')
  })
})
