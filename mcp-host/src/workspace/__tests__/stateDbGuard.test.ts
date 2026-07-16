/**
 * D3 (stateless-agents) §1.2 — defense-in-depth guard: agent file tools and
 * shell_exec must reject any path resolving to the session state database
 * (state.db / state.db-wal / state.db-shm) or the reserved `.clerum-state/`
 * directory — loudly, with the database left untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileReadTool } from '../../core/tools/fileRead'
import { FileWriteTool } from '../../core/tools/fileWrite'
import { PersistentMemoryWriteTool } from '../../core/tools/memory'
import { ShellTool } from '../../core/tools/shell'
import { StateDbPathError, WorkspaceService, isStateDbPath } from '../service'

describe('isStateDbPath', () => {
  it.each([
    'state.db',
    './state.db',
    '/state.db',
    'state.db-wal',
    'state.db-shm',
    'sub/state.db',
    'sub/deep/state.db-wal',
    '.clerum-state',
    '.clerum-state/anything.json',
    'nested/.clerum-state/file',
  ])('rejects %s', p => {
    expect(isStateDbPath(p)).toBe(true)
  })

  it.each([
    'notes.md',
    'state.db.bak',
    'state.database',
    'mystate.db',
    'daily/2026-07-03.md',
    'clerum-state/file',
    '',
  ])('allows %s', p => {
    expect(isStateDbPath(p)).toBe(false)
  })
})

describe('state-db guard enforcement', () => {
  let workspace: string
  const dbContent = 'SQLITE-BYTES-DO-NOT-TOUCH'

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-guard-'))
    fs.writeFileSync(path.join(workspace, 'state.db'), dbContent, 'utf-8')
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function dbUntouched(): void {
    expect(fs.readFileSync(path.join(workspace, 'state.db'), 'utf-8')).toBe(dbContent)
  }

  describe('WorkspaceService', () => {
    it('write/append/delete throw StateDbPathError and leave the db untouched', async () => {
      const service = new WorkspaceService(workspace)
      await expect(service.write('state.db', 'x')).rejects.toThrow(StateDbPathError)
      await expect(service.append('state.db-wal', 'x')).rejects.toThrow(StateDbPathError)
      await expect(service.delete('state.db')).rejects.toThrow(StateDbPathError)
      await expect(service.write('.clerum-state/marker', 'x')).rejects.toThrow(StateDbPathError)
      await expect(service.write('sub/state.db-shm', 'x')).rejects.toThrow(StateDbPathError)
      dbUntouched()
    })

    it('non-protected paths still work', async () => {
      const service = new WorkspaceService(workspace)
      await service.write('notes/today.md', 'hello')
      expect(await service.read('notes/today.md')).toBe('hello')
    })
  })

  describe('file_write tool', () => {
    it('rejects a write to state.db loudly; db untouched', async () => {
      const tool = new FileWriteTool(workspace)
      const out = await tool.execute({ path: 'state.db', content: 'overwrite' })
      expect(out.is_error).toBe(true)
      expect(out.content).toContain('session state database')
      dbUntouched()
    })

    it('rejects the WAL laterals and .clerum-state', async () => {
      const tool = new FileWriteTool(workspace)
      for (const p of ['state.db-wal', 'state.db-shm', '.clerum-state/x']) {
        const out = await tool.execute({ path: p, content: 'x' })
        expect(out.is_error).toBe(true)
        expect(out.content).toContain('session state database')
      }
    })
  })

  describe('file_read tool', () => {
    it('rejects a read of state.db loudly', async () => {
      const tool = new FileReadTool(workspace)
      const out = await tool.execute({ path: 'state.db' })
      expect(out.is_error).toBe(true)
      expect(out.content).toContain('session state database')
    })
  })

  describe('memory_write tool', () => {
    it('rejects a target resolving to state.db loudly; db untouched', async () => {
      const service = new WorkspaceService(workspace)
      const tool = new PersistentMemoryWriteTool(service)
      const out = await tool.execute({ content: 'x', target: 'state.db' })
      expect(out.is_error).toBe(true)
      expect(out.content).toContain('session state database')
      dbUntouched()
    })
  })

  describe('shell_exec tool', () => {
    function shell(): ShellTool {
      return new ShellTool(workspace, 5000, ['PATH'])
    }

    it.each([
      'cat state.db',
      'rm -f ./state.db-wal',
      'cp state.db /tmp/exfil.db',
      'sqlite3 /data/sessions/state.db .dump',
      'ls .clerum-state/',
      'echo x > state.db-shm',
    ])('rejects: %s (db untouched)', async command => {
      const out = await shell().execute({ command })
      expect(out.is_error).toBe(true)
      expect(out.content).toContain('Command rejected')
      dbUntouched()
    })

    it('allows unrelated commands (including near-miss names)', async () => {
      const out = await shell().execute({ command: 'echo interstate.db statement' })
      expect(out.is_error).toBe(false)
      expect(out.content).toContain('interstate.db statement')
    })
  })
})
