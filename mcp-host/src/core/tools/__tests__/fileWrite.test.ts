import { beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { FileWriteTool } from '../fileWrite'

describe('FileWriteTool — admin-managed file gate', () => {
  let tool: FileWriteTool
  let workspaceDir: string

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fwgate-'))
    tool = new FileWriteTool(workspaceDir, new Set())
  })

  for (const name of ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md']) {
    it(`returns is_error=true for ${name}`, async () => {
      const res = await tool.execute({ path: name, content: 'hijack' })
      expect(res.is_error).toBe(true)
      expect(res.content).toContain(name)
      expect(res.content).toContain('admin-managed')
    })
  }

  it('does NOT create the file when path is locked', async () => {
    await tool.execute({ path: 'IDENTITY.md', content: 'hijack' })
    await expect(fs.stat(path.join(workspaceDir, 'IDENTITY.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects locked path with append: true', async () => {
    const res = await tool.execute({ path: 'IDENTITY.md', content: 'x', append: true })
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('admin-managed')
  })

  it('rejects normalized variants (./IDENTITY.md, /IDENTITY.md, IDENTITY.md/)', async () => {
    for (const variant of ['./IDENTITY.md', '/IDENTITY.md', 'IDENTITY.md/']) {
      const res = await tool.execute({ path: variant, content: 'hijack' })
      expect(res.is_error).toBe(true)
    }
  })

  it('allows writes to non-locked paths', async () => {
    const res = await tool.execute({ path: 'notes.md', content: 'ok' })
    expect(res.is_error).toBe(false)
  })

  it('allows writes to subdirectory paths even when basename matches', async () => {
    const res = await tool.execute({ path: 'daily/AGENTS.md', content: 'subdir ok' })
    expect(res.is_error).toBe(false)
  })
})

describe('FileWriteTool — reserved memory folder names', () => {
  let workspaceDir: string

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fwreserved-'))
  })

  it.each([
    ['memory', 'memory'],
    ['memory/', 'memory'],
    ['./memory', 'memory'],
    ['daily', 'daily'],
  ])('with {memory, daily} reserved, %s is refused and nothing is created', async (p, name) => {
    const tool = new FileWriteTool(workspaceDir, new Set(['memory', 'daily']))
    const res = await tool.execute({ path: p, content: 'x' })
    expect(res.is_error).toBe(true)
    expect(res.content).toBe(
      `'${name}' is a memory folder, not a file. Write inside it: ${name}/<file>.md.`
    )
    expect(await fs.readdir(workspaceDir)).toEqual([])
  })

  it.each([
    ['/memory', 'Error: Absolute paths not allowed'],
    ['//memory', 'Error: Absolute paths not allowed'],
    ['/daily', 'Error: Absolute paths not allowed'],
    ['a/../memory', 'Error: Directory traversal (..) not allowed'],
    ['memory/../daily', 'Error: Directory traversal (..) not allowed'],
  ])(
    'with {memory, daily} reserved, %s keeps its refusal by text (%s), nothing is created',
    async (p, message) => {
      const reserved = new FileWriteTool(workspaceDir, new Set(['memory', 'daily']))
      const res = await reserved.execute({ path: p, content: 'x' })
      expect(res.is_error).toBe(true)
      expect(res.content).toBe(message)
      // The same answer as with nothing reserved: the reservation adds nothing here.
      const plain = await new FileWriteTool(workspaceDir, new Set()).execute({
        path: p,
        content: 'x',
      })
      expect(plain.content).toBe(message)
      expect(await fs.readdir(workspaceDir)).toEqual([])
    }
  )

  it('with {memory, daily} reserved, memories and memory/x.md are written', async () => {
    const tool = new FileWriteTool(workspaceDir, new Set(['memory', 'daily']))
    for (const p of ['memories', 'memory/x.md']) {
      const res = await tool.execute({ path: p, content: `body ${p}` })
      expect(res.is_error).toBe(false)
      await expect(fs.readFile(path.join(workspaceDir, p), 'utf-8')).resolves.toBe(`body ${p}`)
    }
  })

  it('with nothing reserved, memory and daily are written as files', async () => {
    const tool = new FileWriteTool(workspaceDir, new Set())
    for (const p of ['memory', 'daily']) {
      const res = await tool.execute({ path: p, content: `body ${p}` })
      expect(res.is_error).toBe(false)
      expect((await fs.stat(path.join(workspaceDir, p))).isFile()).toBe(true)
    }
  })
})
