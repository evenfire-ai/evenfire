/**
 * With one PVC layout for every lifecycle, the conversation database sits at
 * the workspace root next to agent files, together with its journals and the
 * `state.db*.pre-<ts>.bak` copies an older layout left behind. Every name
 * starting with `state.db` is store data, so the workspace API, its listing
 * and search, and the file tools deny it, directly and through a symlink.
 * Ordinary files with similar names stay usable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileReadTool } from '../../core/tools/fileRead'
import { FileWriteTool } from '../../core/tools/fileWrite'
import { ShellTool } from '../../core/tools/shell'
import { ProtectedWorkspacePathError } from '../protectedPaths'
import { WorkspaceService, isStateDbPath } from '../service'

const STORE_BYTES = 'STORE-FILE-DO-NOT-TOUCH'
const STORE_FILES = ['state.db.pre-1.bak', 'state.db-wal', 'state.db.export.md']
// Symlinks that resolve to store files.
const ALIASES = ['bak-link', 'alias.md']
const PROTECTED = [...STORE_FILES, ...ALIASES]

describe('isStateDbPath', () => {
  it.each([
    'state.db',
    'state.db-wal',
    'state.db-shm',
    'state.db.pre-1.bak',
    'state.db-wal.pre-1.bak',
    'nested/state.db.pre-1.bak',
  ])('rejects %s', p => {
    expect(isStateDbPath(p)).toBe(true)
  })

  it.each(['mystate.db.txt', 'state.database', 'state/notes.md', 'notes.md'])('allows %s', p => {
    expect(isStateDbPath(p)).toBe(false)
  })
})

describe('conversation-store files are not agent-accessible', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-files-'))
    for (const p of STORE_FILES) {
      fs.writeFileSync(path.join(root, p), `${STORE_BYTES}\n\nneedle`, 'utf-8')
    }
    fs.symlinkSync(path.join(root, 'state.db.pre-1.bak'), path.join(root, 'bak-link'))
    fs.symlinkSync(path.join(root, 'state.db.export.md'), path.join(root, 'alias.md'))
    fs.writeFileSync(path.join(root, 'mystate.db.txt'), 'lookalike-ok', 'utf-8')
    fs.writeFileSync(path.join(root, 'notes.md'), 'ordinary-ok\n\nneedle', 'utf-8')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function storeFilesUntouched(): void {
    for (const p of STORE_FILES) {
      expect(fs.readFileSync(path.join(root, p), 'utf-8')).toBe(`${STORE_BYTES}\n\nneedle`)
    }
  }

  it('WorkspaceService denies reads and writes, directly and through a symlink', async () => {
    const workspace = new WorkspaceService(root)
    for (const p of PROTECTED) {
      await expect(workspace.read(p), `read ${p}`).rejects.toBeInstanceOf(
        ProtectedWorkspacePathError
      )
      await expect(workspace.write(p, 'x'), `write ${p}`).rejects.toBeInstanceOf(
        ProtectedWorkspacePathError
      )
    }
    storeFilesUntouched()
    // Witness: the lookalike is served and the ordinary file is written.
    expect(await workspace.read('mystate.db.txt')).toBe('lookalike-ok')
    await workspace.write('notes.md', 'ordinary-written')
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf-8')).toBe('ordinary-written')
  })

  it('list omits store files and search never returns them', async () => {
    const workspace = new WorkspaceService(root)
    const names = (await workspace.list()).map(e => e.name)
    // Witness: the listing has the ordinary files.
    expect(names).toEqual(expect.arrayContaining(['mystate.db.txt', 'notes.md']))
    for (const p of PROTECTED) expect(names).not.toContain(p)

    const all = await workspace.listAll()
    // Witness: the recursive listing has the ordinary files.
    expect(all).toEqual(expect.arrayContaining(['mystate.db.txt', 'notes.md']))
    for (const p of PROTECTED) expect(all).not.toContain(p)

    const hits = (await workspace.search('needle')).map(r => r.path)
    // Witness: the same query finds the ordinary note.
    expect(hits).toContain('notes.md')
    expect(hits).not.toContain('state.db.export.md')
    expect(hits).not.toContain('alias.md')
  })

  it('list skips a link that cannot be resolved and keeps its siblings', async () => {
    fs.symlinkSync('loop', path.join(root, 'loop'))
    fs.symlinkSync('notes.md/child', path.join(root, 'through-file'))
    fs.symlinkSync('missing', path.join(root, 'dangling'))
    const workspace = new WorkspaceService(root)
    const names = (await workspace.list()).map(e => e.name)
    // Witness: the ordinary files and the dangling link stay listed.
    expect(names).toEqual(expect.arrayContaining(['mystate.db.txt', 'notes.md', 'dangling']))
    // ELOOP and ENOTDIR omit only their own entry.
    expect(names).not.toContain('loop')
    expect(names).not.toContain('through-file')
    for (const p of PROTECTED) expect(names).not.toContain(p)

    const all = await workspace.listAll()
    expect(all).toEqual(expect.arrayContaining(['mystate.db.txt', 'notes.md']))
    for (const p of PROTECTED) expect(all).not.toContain(p)
  })

  it('file_read and file_write deny them, directly and through a symlink', async () => {
    const reader = new FileReadTool(root)
    const writer = new FileWriteTool(root)
    for (const p of PROTECTED) {
      const read = await reader.execute({ path: p })
      expect(read.is_error, `file_read ${p}`).toBe(true)
      expect(read.content).not.toContain(STORE_BYTES)
      const write = await writer.execute({ path: p, content: 'x' })
      expect(write.is_error, `file_write ${p}`).toBe(true)
    }
    storeFilesUntouched()
    // Witness: the same tools read the lookalike and write the ordinary file.
    const lookalike = await reader.execute({ path: 'mystate.db.txt' })
    expect(lookalike.is_error).toBe(false)
    expect(lookalike.content).toContain('lookalike-ok')
    const ordinary = await writer.execute({ path: 'notes.md', content: 'tool-written' })
    expect(ordinary.is_error).toBe(false)
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf-8')).toBe('tool-written')
  })

  // The shell gate is lexical only and is not a security boundary; these are
  // regression tests of the name check.
  describe('shell_exec lexical gate', () => {
    function shell(): ShellTool {
      return new ShellTool(root, 5000, ['PATH'])
    }

    it.each([
      'cat state.db.pre-1.bak',
      'cat state.db-wal',
      'echo y > state.db.pre-2.bak',
      'cat state.db_old',
      'cat state.db2',
    ])('rejects by name: %s', async command => {
      const out = await shell().execute({ command })
      expect(out.is_error).toBe(true)
      expect(out.content).toContain('Command rejected')
      expect(out.content).not.toContain(STORE_BYTES)
      storeFilesUntouched()
      expect(fs.existsSync(path.join(root, 'state.db.pre-2.bak'))).toBe(false)
    })

    it('runs commands on the lookalike and the ordinary file', async () => {
      const out = await shell().execute({
        command: 'cat mystate.db.txt notes.md && echo z > notes.md',
      })
      expect(out.is_error).toBe(false)
      expect(out.content).toContain('lookalike-ok')
      expect(out.content).toContain('ordinary-ok')
      expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf-8')).toBe('z\n')
    })
  })
})
