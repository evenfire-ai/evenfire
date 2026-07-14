import { beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { WorkspaceService } from '../../../workspace/service'
import { PersistentMemoryWriteTool } from '../memory'

describe('PersistentMemoryWriteTool — admin-managed file guard', () => {
  let workspace: WorkspaceService
  let tool: PersistentMemoryWriteTool

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memwrite-'))
    workspace = new WorkspaceService(dir)
    tool = new PersistentMemoryWriteTool(workspace)
  })

  for (const target of ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md']) {
    it(`returns is_error with admin-managed message for target=${target}`, async () => {
      const result = await tool.execute({ content: 'agent override', target })
      expect(result.is_error).toBe(true)
      expect(result.content).toContain(target)
      expect(result.content).toContain('admin-managed')
    })
  }

  it('does NOT write the file when target is locked', async () => {
    await tool.execute({ content: 'agent override', target: 'IDENTITY.md' })
    expect(await workspace.read('IDENTITY.md')).toBeNull()
  })

  it('rejects normalized variants of locked targets (./IDENTITY.md, /IDENTITY.md, IDENTITY.md/)', async () => {
    for (const variant of ['./IDENTITY.md', '/IDENTITY.md', 'IDENTITY.md/']) {
      const result = await tool.execute({ content: 'hijack', target: variant })
      expect(result.is_error).toBe(true)
      expect(result.content).toContain('admin-managed')
    }
  })

  it('allows writes to non-locked targets (memory)', async () => {
    const result = await tool.execute({ content: 'ok', target: 'memory' })
    expect(result.is_error).toBe(false)
    expect(await workspace.read('MEMORY.md')).toContain('ok')
  })

  it('allows writes to subdirectory paths even with locked basename', async () => {
    const result = await tool.execute({
      content: 'subdir ok',
      target: 'daily/AGENTS.md',
      append: false,
    })
    expect(result.is_error).toBe(false)
    expect(await workspace.read('daily/AGENTS.md')).toBe('subdir ok')
  })

  it('catches LockedFileError raised by the workspace as a clean is_error', async () => {
    // Force-trigger by passing a target whose normalization differs
    // (the tool's isLockedPath should already catch root variants, so this is
    // a defense-in-depth test against future tool wrappers that bypass the
    // top-level gate). We simulate by using append mode on the locked path.
    const result = await tool.execute({ content: 'x', target: 'AGENTS.md', append: true })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('admin-managed')
  })
})
