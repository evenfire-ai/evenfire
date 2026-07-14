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
    tool = new FileWriteTool(workspaceDir)
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
