import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { logger } from '../../../logger'
import type { MemoryWriteEntry, MemoryWriteLog } from '../../../workspace/memoryWriteLog'
import { memoryWriteRecordFailuresTotal } from '../../../workspace/memoryWriteLog'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import type { Workspace } from '../../../workspace/service'
import { WorkspaceService } from '../../../workspace/service'
import {
  MemorySearchTool,
  MemoryTreeTool,
  PersistentMemoryReadTool,
  PersistentMemoryWriteTool,
} from '../memory'

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

// ─── Named notes in memory/ (PR C: D61, D62, D79, D82, D84, D91, D92, D104) ──────

const today = new Date().toISOString().slice(0, 10)

interface UserTools {
  write: PersistentMemoryWriteTool
  read: PersistentMemoryReadTool
  search: MemorySearchTool
}

describe('memory tools — named notes live in the caller memory/ folder', () => {
  let baseRoot: string
  let alice: UserTools
  let bob: UserTools

  function toolsFor(provider: ScopedWorkspaceProvider, userKey: string): UserTools {
    const ws = provider.forUser(userKey)
    return {
      write: new PersistentMemoryWriteTool(ws),
      read: new PersistentMemoryReadTool(ws),
      search: new MemorySearchTool(ws),
    }
  }
  const userFile = (userKey: string, rel: string) => path.join(baseRoot, 'users', userKey, rel)
  const exists = (abs: string) =>
    fs.access(abs).then(
      () => true,
      () => false
    )
  const readJson = (content: string) => JSON.parse(content) as { path: string; content: string }
  const searchPaths = async (tools: UserTools, query: string) => {
    const out = await tools.search.execute({ query, limit: 20 })
    expect(out.is_error).toBe(false)
    return (JSON.parse(out.content) as { results: { path: string }[] }).results.map(r => r.path)
  }

  beforeEach(async () => {
    baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-notes-'))
    const provider = new ScopedWorkspaceProvider(baseRoot)
    alice = toolsFor(provider, 'alice')
    bob = toolsFor(provider, 'bob')
  })

  afterEach(async () => {
    await fs.rm(baseRoot, { recursive: true, force: true })
  })

  it('row 13: notes.md and projects/acme.md land in memory/ and the result names memory/<path>', async () => {
    for (const target of ['notes.md', 'projects/acme.md']) {
      const out = await alice.write.execute({ content: `body of ${target}`, target })
      expect(out.is_error).toBe(false)
      expect(out.content).toBe(`Written to memory/${target} (append)`)
      await expect(fs.readFile(userFile('alice', `memory/${target}`), 'utf-8')).resolves.toBe(
        `body of ${target}`
      )
    }
    expect(await exists(userFile('alice', 'notes.md'))).toBe(false)
  })

  it('D79, D92: a private note preferences.md is saved as memory/preferences.md', async () => {
    const out = await alice.write.execute({ content: 'likes tea', target: 'preferences.md' })
    expect(out.content).toBe('Written to memory/preferences.md (append)')
    await expect(fs.readFile(userFile('alice', 'memory/preferences.md'), 'utf-8')).resolves.toBe(
      'likes tea'
    )
    expect(await exists(userFile('alice', 'preferences.md'))).toBe(false)
  })

  it('D92: a shared note memories/team-conventions.md goes to the Host root and another user reads it', async () => {
    const out = await alice.write.execute({
      content: 'zzteamconvention squash merges',
      target: 'memories/team-conventions.md',
    })
    expect(out.content).toBe('Written to memories/team-conventions.md (append)')
    await expect(
      fs.readFile(path.join(baseRoot, 'memories', 'team-conventions.md'), 'utf-8')
    ).resolves.toBe('zzteamconvention squash merges')
    const read = await bob.read.execute({ path: 'memories/team-conventions.md' })
    expect(read.is_error).toBe(false)
    expect(readJson(read.content).content).toBe('zzteamconvention squash merges')
    expect(await exists(userFile('alice', 'memory/memories'))).toBe(false)
  })

  it('row 5: MEMORY.md, HEARTBEAT.md and memories/x.md as targets are written at the Host root', async () => {
    for (const target of ['MEMORY.md', 'HEARTBEAT.md', 'memories/x.md']) {
      const out = await alice.write.execute({ content: `root ${target}`, target })
      expect(out.is_error).toBe(false)
      expect(out.content).toBe(`Written to ${target} (append)`)
      await expect(fs.readFile(path.join(baseRoot, target), 'utf-8')).resolves.toBe(
        `root ${target}`
      )
      expect(await exists(userFile('alice', `memory/${target}`))).toBe(false)
    }
  })

  it('rows 24 to 26: collective files are read where they are, by both users', async () => {
    const files: Record<string, string> = {
      'MEMORY.md': 'zzcollectivememory',
      'memories/x.md': 'zzcollectivenote',
      'HEARTBEAT.md': 'zzheartbeat',
      'IDENTITY.md': 'zzidentity',
    }
    await fs.mkdir(path.join(baseRoot, 'memories'), { recursive: true })
    for (const [rel, marker] of Object.entries(files)) {
      await fs.writeFile(path.join(baseRoot, rel), marker, 'utf-8')
    }
    const reads: [string, string][] = [
      ['MEMORY.md', 'zzcollectivememory'],
      ['./MEMORY.md', 'zzcollectivememory'],
      ['memories/x.md', 'zzcollectivenote'],
      ['HEARTBEAT.md', 'zzheartbeat'],
      ['IDENTITY.md', 'zzidentity'],
    ]
    for (const tools of [alice, bob]) {
      for (const [p, marker] of reads) {
        const out = await tools.read.execute({ path: p })
        expect(out.is_error).toBe(false)
        expect(readJson(out.content).content).toBe(marker)
      }
    }
    // Row 25: a search hit in memories/ is memory and memory_read opens it.
    expect(await searchPaths(alice, 'zzcollectivenote')).toContain('memories/x.md')
    const hit = await alice.read.execute({ path: 'memories/x.md' })
    expect(readJson(hit.content).content).toBe('zzcollectivenote')
  })

  it('row 28: memory_read of MEMORY.md returns the shared file; scope private returns the private one', async () => {
    await alice.write.execute({ content: 'zzsharedmarker', target: 'memory' })
    await alice.write.execute({ content: 'zzprivatemarker', target: 'memory_private' })
    const shared = await alice.read.execute({ path: 'MEMORY.md' })
    expect(readJson(shared.content).content).toBe('zzsharedmarker')
    const priv = await alice.read.execute({ scope: 'private' })
    expect((JSON.parse(priv.content) as { content: string }).content).toBe('zzprivatemarker')
  })

  it('D84, rows 13a, 13b, 14: a name without .md gets .md and is read back by every form', async () => {
    const out = await alice.write.execute({ content: 'zzsecretcode 42', target: 'secret_code' })
    expect(out.content).toBe('Written to memory/secret_code.md (append)')
    await expect(fs.readFile(userFile('alice', 'memory/secret_code.md'), 'utf-8')).resolves.toBe(
      'zzsecretcode 42'
    )
    expect(await exists(userFile('alice', 'memory/secret_code'))).toBe(false)
    for (const p of ['secret_code', 'secret_code.md', 'memory/secret_code']) {
      const read = await alice.read.execute({ path: p })
      expect(read.is_error).toBe(false)
      expect(readJson(read.content).content).toBe('zzsecretcode 42')
    }
    expect(await searchPaths(alice, 'zzsecretcode')).toContain('memory/secret_code.md')

    const json = await alice.write.execute({ content: 'zzdatajson', target: 'data.json' })
    expect(json.content).toBe('Written to memory/data.json.md (append)')
    await expect(fs.readFile(userFile('alice', 'memory/data.json.md'), 'utf-8')).resolves.toBe(
      'zzdatajson'
    )
    expect(await exists(userFile('alice', 'memory/data.json'))).toBe(false)
    expect(readJson((await alice.read.execute({ path: 'data.json' })).content).content).toBe(
      'zzdatajson'
    )
    expect(await searchPaths(alice, 'zzdatajson')).toContain('memory/data.json.md')

    const mj = await alice.write.execute({ content: 'zzmemdatajson', target: 'memory/data.json' })
    expect(mj.content).toBe('Written to memory/data.json.md (append)')

    const daily = await alice.write.execute({ content: 'dailynoext', target: 'daily/2026-11-10' })
    expect(daily.content).toBe('Written to daily/2026-11-10 (append)')
    await expect(fs.readFile(userFile('alice', 'daily/2026-11-10'), 'utf-8')).resolves.toBe(
      'dailynoext'
    )
  })

  it('D104, rows 13c, 13d: dotted names, other endings and upper case all gain .md', async () => {
    const cases: [string, string][] = [
      ['john.smith', 'memory/john.smith.md'],
      ['script.py', 'memory/script.py.md'],
      ['NOTES.MD', 'memory/NOTES.MD.md'],
    ]
    for (const [target, stored] of cases) {
      const out = await alice.write.execute({ content: `zz${target.replace(/\W/g, '')}`, target })
      expect(out.content).toBe(`Written to ${stored} (append)`)
      expect(await exists(userFile('alice', stored))).toBe(true)
    }
    expect(await exists(userFile('alice', 'memory/john.smith'))).toBe(false)
    expect(readJson((await alice.read.execute({ path: 'john.smith' })).content).content).toBe(
      'zzjohnsmith'
    )
    expect(await searchPaths(alice, 'zzjohnsmith')).toContain('memory/john.smith.md')
  })

  it('row 14b: a pre-existing memory/data.json is not opened by memory_read', async () => {
    await fs.mkdir(userFile('alice', 'memory'), { recursive: true })
    await fs.writeFile(userFile('alice', 'memory/data.json'), 'legacy json', 'utf-8')
    const out = await alice.read.execute({ path: 'memory/data.json' })
    expect(out.is_error).toBe(true)
    expect(out.content).toBe('File not found: memory/data.json.md')
    await expect(fs.readFile(userFile('alice', 'memory/data.json'), 'utf-8')).resolves.toBe(
      'legacy json'
    )
  })

  it('row 14a: a pre-existing memory/playbook is not opened by memory_read', async () => {
    await fs.mkdir(userFile('alice', 'memory'), { recursive: true })
    await fs.writeFile(userFile('alice', 'memory/playbook'), 'legacy playbook', 'utf-8')
    const out = await alice.read.execute({ path: 'memory/playbook' })
    expect(out.is_error).toBe(true)
    expect(out.content).toBe('File not found: memory/playbook.md')
    await expect(fs.readFile(userFile('alice', 'memory/playbook'), 'utf-8')).resolves.toBe(
      'legacy playbook'
    )
  })

  it('row 13e: notes. is refused with the traversal error and nothing is written', async () => {
    const ok = await alice.write.execute({ content: 'before', target: 'first.md' })
    expect(ok.content).toBe('Written to memory/first.md (append)')
    await expect(alice.write.execute({ content: 'x', target: 'notes.' })).rejects.toThrow(
      'Directory traversal (..) not allowed'
    )
    expect(await fs.readdir(userFile('alice', 'memory'))).toEqual(['first.md'])
  })

  it('rows 29, 30: daily/ and ./memory become notes and do not block the daily log', async () => {
    const d = await alice.write.execute({ content: 'zzdailyfolder', target: 'daily/' })
    expect(d.content).toBe('Written to memory/daily.md (append)')
    expect(await exists(userFile('alice', 'memory/daily.md'))).toBe(true)
    const log = await alice.write.execute({ content: 'log line', target: 'daily_log' })
    expect(log.is_error).toBe(false)
    expect((await fs.stat(userFile('alice', 'daily'))).isDirectory()).toBe(true)
    expect(await exists(userFile('alice', `daily/${today}.md`))).toBe(true)
    const m = await alice.write.execute({ content: 'zzmemoryfolder', target: './memory' })
    expect(m.content).toBe('Written to memory/memory.md (append)')
    expect(await exists(userFile('alice', 'memory/memory.md'))).toBe(true)
  })

  it('row 31: the path field of memory_read is the resolved path; unchanged for exempt paths', async () => {
    await alice.write.execute({ content: 'zzsecret', target: 'secret_code' })
    expect(readJson((await alice.read.execute({ path: 'secret_code' })).content).path).toBe(
      'memory/secret_code.md'
    )
    await alice.write.execute({ content: 'zzdaily', target: `daily/${today}.md` })
    expect(readJson((await alice.read.execute({ path: `daily/${today}.md` })).content).path).toBe(
      `daily/${today}.md`
    )
  })

  it('not doubled: memory/x.md is stored at memory/x.md', async () => {
    await alice.write.execute({ content: 'zzx', target: 'memory/x.md' })
    await expect(fs.readFile(userFile('alice', 'memory/x.md'), 'utf-8')).resolves.toBe('zzx')
    expect(await exists(userFile('alice', 'memory/memory/x.md'))).toBe(false)
  })

  it('row 14: a note is read back with the path it was written with and with the memory/ form', async () => {
    await alice.write.execute({ content: 'zzacme', target: 'projects/acme.md' })
    for (const p of ['projects/acme.md', 'memory/projects/acme.md']) {
      expect(readJson((await alice.read.execute({ path: p })).content).content).toBe('zzacme')
    }
  })

  it('rows 15, 16: a file at the old location is not read, and an append starts a new note', async () => {
    await fs.writeFile(userFile('alice', 'notes.md'), 'old location', 'utf-8')
    const out = await alice.read.execute({ path: 'notes.md' })
    expect(out.is_error).toBe(true)
    expect(out.content).toBe('File not found: memory/notes.md')
    await expect(fs.readFile(userFile('alice', 'notes.md'), 'utf-8')).resolves.toBe('old location')
    await alice.write.execute({ content: 'new', target: 'notes.md' })
    await expect(fs.readFile(userFile('alice', 'memory/notes.md'), 'utf-8')).resolves.toBe('new')
    await expect(fs.readFile(userFile('alice', 'notes.md'), 'utf-8')).resolves.toBe('old location')
  })

  it('row 17 and isolation: a note is searched for its writer only', async () => {
    await alice.write.execute({ content: 'zzacmeisolation', target: 'projects/acme.md' })
    expect(await searchPaths(alice, 'zzacmeisolation')).toContain('memory/projects/acme.md')
    expect(readJson((await alice.read.execute({ path: 'projects/acme.md' })).content).content).toBe(
      'zzacmeisolation'
    )
    const bobRead = await bob.read.execute({ path: 'projects/acme.md' })
    expect(bobRead.is_error).toBe(true)
    expect(bobRead.content).toBe('File not found: memory/projects/acme.md')
    expect(await searchPaths(bob, 'zzacmeisolation')).toEqual([])
  })

  it("rows 6 to 8, 10: refusals keep today's errors and write nothing", async () => {
    const ok = await alice.write.execute({ content: 'witness', target: 'witness.md' })
    expect(ok.content).toBe('Written to memory/witness.md (append)')
    const locked = await alice.write.execute({ content: 'x', target: 'IDENTITY.md' })
    expect(locked.is_error).toBe(true)
    expect(locked.content).toContain('admin-managed')
    const prot = await alice.write.execute({ content: 'x', target: 'state.db' })
    expect(prot.is_error).toBe(true)
    expect(prot.content).toContain('session state database')
    const cross = await alice.write.execute({ content: 'x', target: 'users/bob/x.md' })
    expect(cross.is_error).toBe(true)
    expect(cross.content).toContain("addresses another user's namespace")
    await expect(alice.write.execute({ content: 'x', target: '/etc/x' })).rejects.toThrow(
      'Absolute paths not allowed'
    )
    await expect(alice.write.execute({ content: 'x', target: 'a/../b' })).rejects.toThrow(
      'Directory traversal (..) not allowed'
    )
    expect(await fs.readdir(userFile('alice', 'memory'))).toEqual(['witness.md'])
    expect(await exists(path.join(baseRoot, 'IDENTITY.md'))).toBe(false)
    expect(await exists(userFile('bob', 'x.md'))).toBe(false)
  })
})

describe('memory tool texts (D79, D83, D91, D92, D99, D104, V2-L6)', () => {
  const ws = {} as WorkspaceService
  const write = new PersistentMemoryWriteTool(ws)
  const read = new PersistentMemoryReadTool(ws)
  const search = new MemorySearchTool(ws)
  const tree = new MemoryTreeTool(ws)
  const target = (write.parametersSchema().properties.target as { description: string }).description
  const readPath = (read.parametersSchema().properties.path as { description: string }).description

  it('target: private notes in memory/, team knowledge in the shared memory (D79, D92)', () => {
    expect(target).toContain('memory/preferences.md')
    expect(target).toContain('belongs in memory/')
    expect(target).toContain('goes to the shared memory')
    expect(target).toContain('are not memory')
    expect(target).not.toContain('team-conventions')
    expect(target).not.toContain('ledger.md')
    expect(target).not.toMatch(/keep[^.]*ledger/i)
  })

  it('one place (D83, D91)', () => {
    expect(read.description()).toContain('This is the only way to read memory')
    expect(read.description()).toContain('a workspace file is not memory')
    expect(search.description()).toContain('not by browsing workspace files')
    expect(write.description()).toContain('other workspace files are not memory')
  })

  it('each of the four descriptions names the four places (D91)', () => {
    for (const text of [
      write.description(),
      read.description(),
      search.description(),
      tree.description(),
    ]) {
      for (const place of ['MEMORY.md', 'memories/', 'daily/', 'memory/']) {
        expect(text).toContain(place)
      }
    }
  })

  it('search and tree say what they return (D99)', () => {
    expect(search.description()).toContain('those are workspace files, not memory')
    expect(search.description()).toContain("scope 'private'")
    expect(tree.description()).toContain('are memory; read those with memory_read')
    expect(tree.description()).not.toBe('View workspace memory structure as a directory tree.')
  })

  it('notes are Markdown only (D104)', () => {
    expect(target).toContain('Notes are Markdown only')
    expect(target).toContain('memory/data.json.md')
    expect(target).toContain(
      'nothing is added to MEMORY.md, HEARTBEAT.md, memories/ or daily/ paths'
    )
  })

  it('the exceptions are named (V2-L6)', () => {
    expect(target).toContain('are written where they are')
    expect(target).toContain('are refused')
    expect(readPath).toContain('are read where they are')
    for (const name of ['HEARTBEAT.md', 'IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md']) {
      expect(readPath).toContain(name)
    }
    expect(tree.description()).toContain('can list MEMORY.md twice')
    expect(tree.description()).toContain("scope 'private'")
  })
})

// ─── Record of every successful memory_write (PR C: D64, D72, D73, D93) ─────────

class CapturingLog implements MemoryWriteLog {
  readonly entries: MemoryWriteEntry[] = []
  async record(entry: MemoryWriteEntry): Promise<void> {
    this.entries.push(entry)
  }
}

class RejectingLog implements MemoryWriteLog {
  constructor(private readonly error: Error) {}
  async record(): Promise<void> {
    throw this.error
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

async function failureCount(scope: 'collective' | 'user'): Promise<number> {
  const metric = await memoryWriteRecordFailuresTotal.get()
  return metric.values.find(v => v.labels.scope === scope)?.value ?? 0
}

describe('memory_write records every successful write', () => {
  let baseRoot: string
  let provider: ScopedWorkspaceProvider
  let log: CapturingLog
  let write: PersistentMemoryWriteTool

  const userFile = (rel: string) => path.join(baseRoot, 'users', 'alice', rel)

  beforeEach(async () => {
    baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-record-'))
    provider = new ScopedWorkspaceProvider(baseRoot)
    log = new CapturingLog()
    write = new PersistentMemoryWriteTool(provider.forUser('alice'), { log, userKey: 'alice' })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(baseRoot, { recursive: true, force: true })
  })

  const cases: Array<{
    row: string
    params: Record<string, unknown>
    scope: 'collective' | 'user'
    relativePath: string
    mode: 'append' | 'replace'
    file: () => string
  }> = [
    {
      row: '1',
      params: { target: 'memory' },
      scope: 'collective',
      relativePath: 'MEMORY.md',
      mode: 'append',
      file: () => path.join(baseRoot, 'MEMORY.md'),
    },
    {
      row: '2 append',
      params: { target: 'memory_private' },
      scope: 'user',
      relativePath: 'MEMORY.md',
      mode: 'append',
      file: () => userFile('MEMORY.md'),
    },
    {
      row: '2 replace',
      params: { target: 'memory_private', append: false },
      scope: 'user',
      relativePath: 'MEMORY.md',
      mode: 'replace',
      file: () => userFile('MEMORY.md'),
    },
    {
      row: '3 append',
      params: { target: 'daily_log' },
      scope: 'user',
      relativePath: `daily/${today}.md`,
      mode: 'append',
      file: () => userFile(`daily/${today}.md`),
    },
    {
      row: '3 replace',
      params: { target: 'daily_log', append: false },
      scope: 'user',
      relativePath: `daily/${today}.md`,
      mode: 'replace',
      file: () => userFile(`daily/${today}.md`),
    },
    {
      row: '4',
      params: { target: 'heartbeat' },
      scope: 'collective',
      relativePath: 'HEARTBEAT.md',
      mode: 'append',
      file: () => path.join(baseRoot, 'HEARTBEAT.md'),
    },
    {
      row: '5 MEMORY.md',
      params: { target: 'MEMORY.md' },
      scope: 'collective',
      relativePath: 'MEMORY.md',
      mode: 'append',
      file: () => path.join(baseRoot, 'MEMORY.md'),
    },
    {
      row: '5 memories/x.md',
      params: { target: 'memories/x.md' },
      scope: 'collective',
      relativePath: 'memories/x.md',
      mode: 'append',
      file: () => path.join(baseRoot, 'memories/x.md'),
    },
    {
      row: '5 HEARTBEAT.md',
      params: { target: 'HEARTBEAT.md' },
      scope: 'collective',
      relativePath: 'HEARTBEAT.md',
      mode: 'append',
      file: () => path.join(baseRoot, 'HEARTBEAT.md'),
    },
    {
      row: '11',
      params: { target: 'daily/2026-11-10.md' },
      scope: 'user',
      relativePath: 'daily/2026-11-10.md',
      mode: 'append',
      file: () => userFile('daily/2026-11-10.md'),
    },
    {
      row: '12',
      params: { target: 'memory/x.md' },
      scope: 'user',
      relativePath: 'memory/x.md',
      mode: 'append',
      file: () => userFile('memory/x.md'),
    },
    {
      row: '13',
      params: { target: 'notes.md' },
      scope: 'user',
      relativePath: 'memory/notes.md',
      mode: 'append',
      file: () => userFile('memory/notes.md'),
    },
    {
      row: 'D92',
      params: { target: 'memories/team-conventions.md' },
      scope: 'collective',
      relativePath: 'memories/team-conventions.md',
      mode: 'append',
      file: () => path.join(baseRoot, 'memories/team-conventions.md'),
    },
  ]

  for (const c of cases) {
    it(`row ${c.row}: one entry with scope ${c.scope}, path ${c.relativePath}, mode ${c.mode}`, async () => {
      const content = `zzrecord ${c.row}`
      const out = await write.execute({ content, ...c.params })
      expect(out.is_error).toBe(false)
      const onDisk = await fs.readFile(c.file(), 'utf-8')
      expect(onDisk).toContain(content)
      expect(log.entries).toHaveLength(1)
      expect(log.entries[0]).toMatchObject({
        userKey: 'alice',
        scope: c.scope,
        relativePath: c.relativePath,
        mode: c.mode,
        contentSha256: sha256(onDisk),
      })
      expect(typeof log.entries[0].writtenAt).toBe('number')
    })
  }

  it('hash: an append records the sha256 of the whole file, not of the fragment', async () => {
    await write.execute({ content: 'first fragment', target: 'notes.md' })
    await write.execute({ content: 'second fragment', target: 'notes.md' })
    expect(log.entries).toHaveLength(2)
    const bytes = await fs.readFile(userFile('memory/notes.md'), 'utf-8')
    expect(bytes).toBe('first fragment\nsecond fragment')
    expect(log.entries[1].contentSha256).toBe(sha256(bytes))
    expect(log.entries[1].contentSha256).not.toBe(sha256('second fragment'))
  })

  it('scope: collective and private MEMORY.md share the path and differ in scope', async () => {
    await write.execute({ content: 'team fact', target: 'memory' })
    await write.execute({ content: 'personal fact', target: 'memory_private' })
    expect(log.entries.map(e => [e.relativePath, e.scope])).toEqual([
      ['MEMORY.md', 'collective'],
      ['MEMORY.md', 'user'],
    ])
  })

  it('rows 6 to 8, 10, 23: refused writes add no entry', async () => {
    await write.execute({ content: 'witness', target: 'witness.md' })
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0].relativePath).toBe('memory/witness.md')
    for (const target of ['IDENTITY.md', 'state.db', 'users/bob/x.md']) {
      const out = await write.execute({ content: 'x', target })
      expect(out.is_error).toBe(true)
    }
    await expect(write.execute({ content: 'x', target: '/etc/x' })).rejects.toThrow()
    await expect(write.execute({ content: 'x', target: 'a/../b' })).rejects.toThrow()
    const scan = await write.execute({ content: 'see .env for the key', target: 'memory' })
    expect(scan.is_error).toBe(true)
    expect(log.entries).toHaveLength(1)
  })

  const failures: Array<[string, Error]> = [
    ['a plain Error', new Error('SQLITE_IOERR: disk I/O error')],
    [
      "the persist queue's timeout error",
      new Error('db worker timeout (2000ms) for op=insert_memory_write'),
    ],
  ]
  const targets: Array<[string, Record<string, unknown>, 'collective' | 'user', string, string]> = [
    [
      'user target notes.md',
      { target: 'notes.md' },
      'user',
      'Written to memory/notes.md (append)',
      'memory/notes.md',
    ],
    [
      'collective target memory',
      { target: 'memory' },
      'collective',
      'Written to MEMORY.md (append)',
      'MEMORY.md',
    ],
  ]
  for (const [failureLabel, error] of failures) {
    for (const [targetLabel, params, scope, successText, relativePath] of targets) {
      it(`D93: a record that rejects with ${failureLabel} keeps the write's success (${targetLabel})`, async () => {
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
        const before = await failureCount(scope)
        const failing = new PersistentMemoryWriteTool(provider.forUser('alice'), {
          log: new RejectingLog(error),
          userKey: 'alice',
        })
        const content = `zzd93 ${scope} ${failureLabel}`
        const out = await failing.execute({ content, ...params })
        expect(out.is_error).toBe(false)
        expect(out.content).toBe(successText)
        expect(out.content).not.toContain('record')
        // Witnesses: the file is written, one log line, the counter rose by one.
        const file = scope === 'user' ? userFile(relativePath) : path.join(baseRoot, relativePath)
        await expect(fs.readFile(file, 'utf-8')).resolves.toContain(content)
        expect(errorSpy).toHaveBeenCalledTimes(1)
        const [fields, message] = errorSpy.mock.calls[0]
        expect(message).toBe('memory write record failed')
        expect(fields).toMatchObject({
          component: 'MemoryWrite',
          scope,
          mode: 'append',
          errorName: 'Error',
          errorMessage: error.message,
        })
        const payload = JSON.stringify(fields)
        expect(payload).not.toContain(relativePath)
        expect(payload).not.toContain('notes')
        expect(payload).not.toContain(content)
        expect(payload).not.toContain('alice')
        expect(await failureCount(scope)).toBe(before + 1)
      })
    }
  }

  it('D93: with a working log the counter does not move and nothing is logged', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const before = await failureCount('user')
    await write.execute({ content: 'fine', target: 'notes.md' })
    expect(log.entries).toHaveLength(1)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(await failureCount('user')).toBe(before)
  })

  it('no port: the write succeeds and the file exists', async () => {
    const bare = new PersistentMemoryWriteTool(provider.forUser('alice'))
    const out = await bare.execute({ content: 'no record', target: 'notes.md' })
    expect(out.is_error).toBe(false)
    await expect(fs.readFile(userFile('memory/notes.md'), 'utf-8')).resolves.toBe('no record')
  })

  it('V2-L1: an error building the entry is thrown, not logged as a record failure', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const before = await failureCount('user')
    // Witness: the same call with a real workspace records one entry.
    await write.execute({ content: 'real', target: 'notes.md', append: false })
    expect(log.entries).toHaveLength(1)

    const brokenLog = new CapturingLog()
    const double = {
      write: async () => undefined,
    } as unknown as Workspace
    const broken = new PersistentMemoryWriteTool(double, { log: brokenLog, userKey: 'alice' })
    await expect(
      broken.execute({ content: 'x', target: 'notes.md', append: false })
    ).rejects.toThrow()
    expect(brokenLog.entries).toHaveLength(0)
    expect(errorSpy).not.toHaveBeenCalledWith(expect.anything(), 'memory write record failed')
    expect(await failureCount('user')).toBe(before)
  })
})
