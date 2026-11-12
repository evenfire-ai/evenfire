import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { memoryNotePath } from '../memoryNotePath'
import { ProtectedWorkspacePathError } from '../protectedPaths'
import { CrossUserAccessError, ScopedWorkspaceProvider } from '../scopedWorkspace'
import { LockedFileError } from '../service'

let baseRoot: string
let provider: ScopedWorkspaceProvider

beforeEach(async () => {
  baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-note-path-'))
  provider = new ScopedWorkspaceProvider(baseRoot)
})

afterEach(async () => {
  await fs.rm(baseRoot, { recursive: true, force: true })
})

describe('memoryNotePath — paths refused today are returned unchanged and refused as today', () => {
  it.each([
    ['a NUL byte', 'notes\0.md', 'Path contains null bytes'],
    ['an absolute path', '/etc/x', 'Absolute paths not allowed'],
    ['a traversal', 'a/../b', 'Directory traversal (..) not allowed'],
    ['a traversal out of the folder', '../other/x.md', 'Directory traversal (..) not allowed'],
  ])('row 1, %s: unchanged, then refused by resolvePath', async (_label, raw, message) => {
    expect(memoryNotePath(raw)).toBe(raw)
    const write = provider.forUser('alice').write(memoryNotePath(raw), 'x')
    await expect(write).rejects.toThrow(message)
  })

  it.each(['state.db', '.gfs-downloads/a/b.md', '.clerum-outputs/x', '.clerum-state/x'])(
    'row 2, protected path %s: unchanged, then ProtectedWorkspacePathError',
    async raw => {
      expect(memoryNotePath(raw)).toBe(raw)
      const write = provider.forUser('alice').write(memoryNotePath(raw), 'x')
      await expect(write).rejects.toBeInstanceOf(ProtectedWorkspacePathError)
    }
  )

  it.each(['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md', './IDENTITY.md', 'IDENTITY.md/'])(
    'row 3, locked identity file %s: unchanged, then LockedFileError',
    async raw => {
      expect(memoryNotePath(raw)).toBe(raw)
      const write = provider.forUser('alice').write(memoryNotePath(raw), 'x')
      await expect(write).rejects.toBeInstanceOf(LockedFileError)
      await expect(provider.forUser('alice').write(memoryNotePath(raw), 'x')).rejects.toThrow(
        'admin-managed'
      )
    }
  )

  it.each(['users', 'users/bob/x.md', './users/bob/x.md'])(
    'row 4, another user namespace %s: unchanged, then CrossUserAccessError',
    async raw => {
      expect(memoryNotePath(raw)).toBe(raw)
      const write = provider.forUser('alice').write(memoryNotePath(raw), 'x')
      await expect(write).rejects.toBeInstanceOf(CrossUserAccessError)
    }
  )

  it.each(['', '.', './'])(
    'row 5, the folder itself %j: unchanged, and the write fails',
    async raw => {
      expect(memoryNotePath(raw)).toBe(raw)
      await expect(provider.forUser('alice').write(memoryNotePath(raw), 'x')).rejects.toThrow()
    }
  )
})

describe('memoryNotePath — exempt paths are returned unchanged', () => {
  it.each([
    'MEMORY.md',
    './MEMORY.md',
    'MEMORY.md/',
    'HEARTBEAT.md',
    'memories/x.md',
    './memories/x.md',
    'memories/team-conventions',
  ])('row 6, collective path %s', raw => {
    expect(memoryNotePath(raw)).toBe(raw)
  })

  it.each(['daily/2026-11-10.md', 'daily/AGENTS.md', 'daily/2026-11-10', './daily/2026-11-10.md'])(
    'row 7, daily path %s (no .md added)',
    raw => {
      expect(memoryNotePath(raw)).toBe(raw)
    }
  )
})

describe('memoryNotePath — named notes go to memory/ and are Markdown', () => {
  it.each([
    ['memory/x.md', 'memory/x.md'],
    ['./memory/x.md', 'memory/x.md'],
    ['memory/playbook', 'memory/playbook.md'],
    ['memory/data.json', 'memory/data.json.md'],
  ])('row 8, %s → %s (not doubled)', (raw, expected) => {
    expect(memoryNotePath(raw)).toBe(expected)
  })

  it.each([
    ['notes.md', 'memory/notes.md'],
    ['./projects/acme.md', 'memory/projects/acme.md'],
    ['projects/acme.md', 'memory/projects/acme.md'],
    ['secret_code', 'memory/secret_code.md'],
    ['.ssh/x', 'memory/.ssh/x.md'],
    ['daily', 'memory/daily.md'],
    ['daily/', 'memory/daily.md'],
    ['./memory', 'memory/memory.md'],
    ['memory/', 'memory/memory.md'],
    ['Memory/x.md', 'memory/Memory/x.md'],
    ['Users/V/x', 'memory/Users/V/x.md'],
    ['notes\\a', 'memory/notes\\a.md'],
    ['preferences.md', 'memory/preferences.md'],
  ])('row 9, %s → %s', (raw, expected) => {
    expect(memoryNotePath(raw)).toBe(expected)
  })

  it.each([
    ['secret_code', 'memory/secret_code.md'],
    ['memory/playbook', 'memory/playbook.md'],
    ['john.smith', 'memory/john.smith.md'],
    ['meeting-2026.11.11', 'memory/meeting-2026.11.11.md'],
    ['v1.2', 'memory/v1.2.md'],
    ['notes.md', 'memory/notes.md'],
    ['data.json', 'memory/data.json.md'],
    ['script.py', 'memory/script.py.md'],
    ['a.txt', 'memory/a.txt.md'],
    ['c.yaml', 'memory/c.yaml.md'],
    ['.hidden', 'memory/.hidden.md'],
    ['.ssh/x', 'memory/.ssh/x.md'],
    ['NOTES.MD', 'memory/NOTES.MD.md'],
  ])('extension rule (D104): %s → %s', (raw, expected) => {
    expect(memoryNotePath(raw)).toBe(expected)
  })

  it('extension rule (D104): notes. → memory/notes..md, refused by a real write with the traversal error', async () => {
    expect(memoryNotePath('notes.')).toBe('memory/notes..md')
    await expect(provider.forUser('alice').write(memoryNotePath('notes.'), 'x')).rejects.toThrow(
      'Directory traversal (..) not allowed'
    )
  })

  it('a named note lands in the caller folder under memory/ through a real ScopedWorkspace', async () => {
    await provider.forUser('alice').write(memoryNotePath('projects/acme'), 'acme note')
    await expect(
      fs.readFile(path.join(baseRoot, 'users', 'alice', 'memory', 'projects', 'acme.md'), 'utf-8')
    ).resolves.toBe('acme note')
  })
})
