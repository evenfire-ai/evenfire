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
    'state.db-journal',
    'state.db.bak',
    'state.db.pre-20260930.bak',
    'state.db-wal.pre-20260930.bak',
    '.canonical-store-import/export/state.db',
    'state/.canonical-store/retired/receipt.md',
    '.clerum-canonical-store-precheck-operation',
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

  describe('canonical store records and aliases', () => {
    const protectedPaths = [
      'state.db.bak',
      'state.db-wal.pre-20260930.bak',
      'state/.canonical-store/retired/catalog.md',
      '.canonical-store-import/export/catalog.md',
      '.clerum-canonical-store',
      '.clerum-canonical-store-precheck-operation',
    ]
    function seedRecords(): void {
      for (const relative of protectedPaths) {
        const target = path.join(workspace, relative)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, 'retained catalog marker')
      }
      fs.writeFileSync(path.join(workspace, 'notes.md'), 'ordinary catalog marker')
    }

    it('blocks reads, writes, appends and deletion while ordinary documents remain usable', async () => {
      seedRecords()
      const service = new WorkspaceService(workspace)
      for (const relative of protectedPaths) {
        await expect(service.read(relative)).rejects.toThrow(StateDbPathError)
        await expect(service.write(relative, 'changed')).rejects.toThrow(StateDbPathError)
        await expect(service.append(relative, 'changed')).rejects.toThrow(StateDbPathError)
        await expect(service.delete(relative)).rejects.toThrow(StateDbPathError)
        expect(await service.exists(relative)).toBe(false)
        expect(fs.readFileSync(path.join(workspace, relative), 'utf-8')).toBe(
          'retained catalog marker'
        )
      }
      await service.append('notes.md', 'visible document')
      expect(await service.read('notes.md')).toContain('visible document')
    })

    it('omits platform records from listing, recursive enumeration and search', async () => {
      seedRecords()
      const service = new WorkspaceService(workspace)
      const listed = (await service.list()).map(entry => entry.path)
      expect(listed).toContain('notes.md')
      expect(listed).not.toContain('state.db')
      expect(listed).not.toContain('state.db.bak')
      expect(listed).not.toContain('.canonical-store-import')
      expect(listed).not.toContain('.clerum-canonical-store')
      expect(await service.listAll()).toEqual(['notes.md'])
      const matches = await service.search('catalog marker')
      expect(matches.map(match => match.path)).toEqual(['notes.md'])
      expect(matches[0].content).toContain('ordinary catalog marker')
    })

    it('blocks in-workspace symlink and hard-link aliases before accessing their bytes', async () => {
      seedRecords()
      fs.symlinkSync(
        path.join(workspace, 'state/.canonical-store/retired/catalog.md'),
        path.join(workspace, 'alias.md')
      )
      fs.symlinkSync(
        path.join(workspace, 'state/.canonical-store'),
        path.join(workspace, 'alias-directory')
      )
      fs.linkSync(path.join(workspace, 'state.db.bak'), path.join(workspace, 'hard-alias.md'))
      const service = new WorkspaceService(workspace)
      const read = new FileReadTool(workspace)
      const write = new FileWriteTool(workspace)
      for (const relative of ['alias.md', 'hard-alias.md']) {
        await expect(service.read(relative)).rejects.toThrow(StateDbPathError)
        await expect(service.append(relative, 'changed')).rejects.toThrow(StateDbPathError)
        expect((await read.execute({ path: relative })).is_error).toBe(true)
        expect(
          (await write.execute({ path: relative, content: 'changed', append: true })).is_error
        ).toBe(true)
      }
      await expect(service.list('alias-directory')).rejects.toThrow(StateDbPathError)
      expect((await service.list()).map(entry => entry.path)).not.toContain('alias.md')
      expect((await service.list()).map(entry => entry.path)).not.toContain('hard-alias.md')
      expect((await service.search('catalog marker')).map(match => match.path)).toEqual([
        'notes.md',
      ])
      expect((await read.execute({ path: 'notes.md' })).is_error).toBe(false)
      expect(fs.readFileSync(path.join(workspace, 'state.db.bak'), 'utf-8')).toBe(
        'retained catalog marker'
      )
    })

    it('preserves legitimate in-workspace document symlinks', async () => {
      fs.writeFileSync(path.join(workspace, 'notes.md'), 'visible document')
      fs.symlinkSync(path.join(workspace, 'notes.md'), path.join(workspace, 'document.md'))
      const service = new WorkspaceService(workspace)
      expect(await service.read('document.md')).toBe('visible document')
      expect((await new FileReadTool(workspace).execute({ path: 'document.md' })).content).toBe(
        'visible document'
      )
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
