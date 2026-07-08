/**
 * Identity-files lockdown — end-to-end agent write surface contract.
 *
 * Confirms that no agent-facing write surface can mutate the four
 * admin-managed identity files (IDENTITY.md, SOUL.md, AGENTS.md, USER.md):
 *
 *   1. WorkspaceService.applyAdminIdentityFiles(...) seeds baseline content.
 *   2. FileWriteTool.execute({ path: "<locked>", ... })          → is_error
 *   3. PersistentMemoryWriteTool.execute({ target: "<locked>" }) → is_error
 *   4. Re-reading each file shows content unchanged from baseline.
 *   5. chmod 0o444 backstop: raw fs.writeFile rejects with EACCES
 *      (skipped under root, since DAC permission checks don't apply).
 *
 * This is the cross-tool lockdown the plan calls out as the "lock the
 * contract" E2E. It mirrors finding #1 (FileWriteTool bypass) being
 * fixed end-to-end without standing up a cluster.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { FileWriteTool } from '../../core/tools/fileWrite'
import { PersistentMemoryWriteTool } from '../../core/tools/memory'
import { WorkspaceService } from '../../workspace/service'

const LOCKED_FILES = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md'] as const

const BASELINE = {
  enabled: true,
  identity: 'I am Clerum, the admin-managed identity baseline.',
  soul: 'Be helpful, honest, and harmless.',
  agents: 'Use tools wisely and report progress.',
  user: 'User context: lockdown test fixture.',
} as const

const EXPECTED: Record<(typeof LOCKED_FILES)[number], string> = {
  'IDENTITY.md': BASELINE.identity,
  'SOUL.md': BASELINE.soul,
  'AGENTS.md': BASELINE.agents,
  'USER.md': BASELINE.user,
}

describe('identity-files lockdown — agent write surfaces', () => {
  let workspaceDir: string
  let workspace: WorkspaceService
  let fileWrite: FileWriteTool
  let memoryWrite: PersistentMemoryWriteTool

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lockdown-'))
    workspace = new WorkspaceService(workspaceDir)
    fileWrite = new FileWriteTool(workspaceDir)
    memoryWrite = new PersistentMemoryWriteTool(workspace)

    // Privileged seed of the four locked files. After this each file is 0o444.
    await workspace.applyAdminIdentityFiles(BASELINE)

    // Sanity-check baseline before any tampering.
    for (const name of LOCKED_FILES) {
      expect(await workspace.read(name)).toBe(EXPECTED[name])
    }
  })

  // ── FileWriteTool ────────────────────────────────────────────────────────────

  describe("FileWriteTool — agent's generic write tool", () => {
    for (const name of LOCKED_FILES) {
      it(`rejects ${name} with admin-managed message and leaves content unchanged`, async () => {
        const result = await fileWrite.execute({ path: name, content: 'AGENT-HIJACK' })

        expect(result.is_error).toBe(true)
        expect(result.content).toContain(name)
        expect(result.content).toContain('admin-managed')

        // Baseline content survives.
        expect(await workspace.read(name)).toBe(EXPECTED[name])
      })

      it(`rejects ${name} with append:true (does not extend the file)`, async () => {
        const result = await fileWrite.execute({
          path: name,
          content: 'APPENDED-HIJACK',
          append: true,
        })

        expect(result.is_error).toBe(true)
        expect(result.content).toContain('admin-managed')
        expect(await workspace.read(name)).toBe(EXPECTED[name])
      })
    }

    it('rejects normalized path variants (./IDENTITY.md, /IDENTITY.md, IDENTITY.md/)', async () => {
      for (const variant of ['./IDENTITY.md', '/IDENTITY.md', 'IDENTITY.md/']) {
        const result = await fileWrite.execute({ path: variant, content: 'HIJACK' })
        expect(result.is_error).toBe(true)
        expect(result.content).toContain('admin-managed')
      }
      // Underlying file is still pristine.
      expect(await workspace.read('IDENTITY.md')).toBe(EXPECTED['IDENTITY.md'])
    })

    it('still allows writes to non-locked paths (regression guard)', async () => {
      const result = await fileWrite.execute({ path: 'notes.md', content: 'scratch' })
      expect(result.is_error).toBe(false)
      expect(await workspace.read('notes.md')).toBe('scratch')
    })
  })

  // ── PersistentMemoryWriteTool ────────────────────────────────────────────────

  describe("PersistentMemoryWriteTool — agent's memory tool", () => {
    for (const name of LOCKED_FILES) {
      it(`rejects target=${name} with admin-managed message and leaves content unchanged`, async () => {
        const result = await memoryWrite.execute({
          content: 'MEMORY-HIJACK',
          target: name,
        })

        expect(result.is_error).toBe(true)
        expect(result.content).toContain(name)
        expect(result.content).toContain('admin-managed')
        expect(await workspace.read(name)).toBe(EXPECTED[name])
      })

      it(`rejects target=${name} with append:false (does not overwrite the file)`, async () => {
        const result = await memoryWrite.execute({
          content: 'MEMORY-OVERWRITE',
          target: name,
          append: false,
        })

        expect(result.is_error).toBe(true)
        expect(result.content).toContain('admin-managed')
        expect(await workspace.read(name)).toBe(EXPECTED[name])
      })
    }

    it('still allows memory_write to MEMORY.md (regression guard)', async () => {
      const result = await memoryWrite.execute({ content: 'agent note', target: 'memory' })
      expect(result.is_error).toBe(false)
      expect(await workspace.read('MEMORY.md')).toContain('agent note')
    })
  })

  // ── chmod 0o444 OS backstop ──────────────────────────────────────────────────

  describe('chmod 0o444 backstop — direct fs.writeFile cannot bypass', () => {
    for (const name of LOCKED_FILES) {
      it(`raw fs.writeFile to ${name} fails with EACCES (skipped under root)`, async () => {
        if (process.getuid?.() === 0) {
          // Root bypasses DAC permission checks — chmod 0o444 doesn't keep root out.
          // The OS-level guarantee applies to non-root container users, which is
          // the production setting; this assertion is structurally exercised in CI.
          return
        }
        const target = path.join(workspaceDir, name)
        await expect(fs.writeFile(target, 'OS-LEVEL-HIJACK', 'utf-8')).rejects.toMatchObject({
          code: 'EACCES',
        })

        // Baseline still intact (chmod 0o444 still allows reads).
        expect(await fs.readFile(target, 'utf-8')).toBe(EXPECTED[name])
      })
    }
  })

  // ── Sweep summary: full surface area in one shot ─────────────────────────────

  it('after a full agent-tool tampering sweep, every locked file equals baseline', async () => {
    for (const name of LOCKED_FILES) {
      await fileWrite.execute({ path: name, content: 'tamper-1' })
      await fileWrite.execute({ path: name, content: 'tamper-2', append: true })
      await memoryWrite.execute({ content: 'tamper-3', target: name })
      await memoryWrite.execute({ content: 'tamper-4', target: name, append: false })
    }
    for (const name of LOCKED_FILES) {
      expect(await workspace.read(name)).toBe(EXPECTED[name])
    }
  })
})
