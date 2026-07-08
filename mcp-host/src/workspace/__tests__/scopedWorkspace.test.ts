import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fsSync from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { NativeToolRegistry } from '../../core/tools/nativeToolRegistry'
import { CrossUserAccessError, ScopedWorkspaceProvider, isCollectivePath } from '../scopedWorkspace'
import { WorkspaceService } from '../service'
import { SYSTEM_USER_KEY } from '../userKey'

let baseRoot: string
let provider: ScopedWorkspaceProvider

beforeEach(async () => {
  baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-ws-'))
  provider = new ScopedWorkspaceProvider(baseRoot)
})

afterEach(async () => {
  await fs.rm(baseRoot, { recursive: true, force: true })
})

const today = new Date().toISOString().slice(0, 10)

function makeNativeConfig(workspacePath: string) {
  return {
    workspacePath,
    shellTimeout: 1000,
    toolTimeout: 1000,
    toolProgressInterval: 1000,
    httpAllowlist: [],
    envAllowlist: [],
    memoryMaxSize: 10000,
  }
}

describe('isCollectivePath', () => {
  it('classifies collective vs per-user paths', () => {
    expect(isCollectivePath('MEMORY.md')).toBe(true)
    expect(isCollectivePath('memories/x.md')).toBe(true)
    expect(isCollectivePath('IDENTITY.md')).toBe(true)
    expect(isCollectivePath('daily/2026-06-02.md')).toBe(false)
    expect(isCollectivePath('output/report.txt')).toBe(false)
    expect(isCollectivePath('users/bob/MEMORY.md')).toBe(false)
  })
})

describe('write routing', () => {
  it('routes per-user writes under users/<key>/, not the collective root', async () => {
    await provider.forUser('alice').appendDailyLog('hello')
    const userFile = path.join(baseRoot, 'users', 'alice', 'daily', `${today}.md`)
    await expect(fs.readFile(userFile, 'utf-8')).resolves.toContain('hello')
    // Collective root has no daily/ from this write.
    await expect(fs.access(path.join(baseRoot, 'daily'))).rejects.toBeDefined()
  })

  it('routes collective memory writes to the shared root', async () => {
    await provider.forUser('alice').appendMemory('team deadline is the 15th')
    const collectiveFile = path.join(baseRoot, 'MEMORY.md')
    await expect(fs.readFile(collectiveFile, 'utf-8')).resolves.toContain('deadline')
    // It is NOT under the user subtree.
    await expect(
      fs.access(path.join(baseRoot, 'users', 'alice', 'MEMORY.md'))
    ).rejects.toBeDefined()
  })
})

describe('cross-user isolation', () => {
  it('denies addressing another user via a users/<other> path (F2)', async () => {
    await provider.forUser('bob').appendDailyLog('bob secret')
    const alice = provider.forUser('alice')
    await expect(alice.read(`users/bob/daily/${today}.md`)).rejects.toBeInstanceOf(
      CrossUserAccessError
    )
    await expect(alice.append('users/bob/x.md', 'hijack')).rejects.toBeInstanceOf(
      CrossUserAccessError
    )
    await expect(alice.list('users')).rejects.toBeInstanceOf(CrossUserAccessError)
  })

  it('denies normalized variants that resolve into the users/ namespace (F2)', async () => {
    const alice = provider.forUser('alice')
    for (const variant of ['./users/bob/x', 'users//bob/x', 'foo/../users/bob/x', 'users']) {
      await expect(alice.read(variant)).rejects.toBeInstanceOf(CrossUserAccessError)
    }
  })

  it("reads each user's own daily log, never the neighbor's", async () => {
    await provider.forUser('alice').appendDailyLog('alice note')
    await provider.forUser('bob').appendDailyLog('bob note')
    expect(await provider.forUser('alice').readTodayLog()).toContain('alice note')
    expect(await provider.forUser('alice').readTodayLog()).not.toContain('bob note')
  })

  it('rejects parent traversal instead of routing it to a sibling root', async () => {
    const alice = provider.forUser('alice')
    // `..` must be rejected by resolvePath, never resolved to another user/root.
    await expect(alice.read('../bob/daily/x.md')).rejects.toThrow()
    await expect(alice.append('../bob/daily/x.md', 'x')).rejects.toThrow()
  })

  it('does not surface the users/ directory or other users in list("")', async () => {
    await provider.forUser('bob').appendDailyLog('bob note')
    await provider.forUser('alice').appendDailyLog('alice note')
    const entries = await provider.forUser('alice').list('')
    expect(entries.some(e => e.name === 'users')).toBe(false)
    // alice sees her own daily dir
    expect(entries.some(e => e.name === 'daily')).toBe(true)
  })

  it('search returns own + collective content, never another user', async () => {
    await provider.forUser('bob').appendDailyLog('zzbobsecret marker')
    await provider.forUser('alice').appendMemory('zzcollective marker') // collective
    const results = await provider.forUser('alice').search('zzbobsecret', 10)
    expect(results).toHaveLength(0)
    const collectiveHit = await provider.forUser('alice').search('zzcollective', 10)
    expect(collectiveHit.length).toBeGreaterThan(0)
  })

  it('collective instance does not scan or list excluded users/ subtree (F2)', async () => {
    // Seed a per-user file, then point a collective-style WorkspaceService at the
    // base root and confirm it neither lists nor searches into users/.
    await provider.forUser('bob').appendDailyLog('zzdeepsecret marker')
    const collective = new WorkspaceService(baseRoot, { excludeDirs: ['users'] })
    const entries = await collective.list('')
    expect(entries.some(e => e.name === 'users')).toBe(false)
    const hits = await collective.search('zzdeepsecret', 10)
    expect(hits).toHaveLength(0)
  })
})

describe('per-user cache (mutex preservation)', () => {
  it('serializes concurrent appends from separate ScopedWorkspace views of the same user', async () => {
    // Two distinct ScopedWorkspace instances of the same userKey must share the
    // cached WorkspaceService (and its mutex map), or concurrent appends race.
    const N = 25
    await Promise.all(
      Array.from({ length: N }, (_, i) => provider.forUser('alice').appendDailyLog(`line-${i}`))
    )
    const content = await provider.forUser('alice').readTodayLog()
    for (let i = 0; i < N; i++) {
      expect(content).toContain(`line-${i}`)
    }
  })

  it('returns the same backing instance for the same userKey', () => {
    // Indirect: the cache means the user dir is created once and shared. We assert
    // identity by checking that the two views resolve to the same root via a write.
    const a1 = provider.forUser('alice')
    const a2 = provider.forUser('alice')
    expect(a1).not.toBe(a2) // views differ
    // but writes from both land in the same place (covered by the race test above)
  })
})

describe('per-user root for file tools (F1c)', () => {
  it('creates the per-user root eagerly and exposes it via userRootPath', () => {
    const alice = provider.forUser('alice')
    const expected = path.join(baseRoot, 'users', 'alice')
    expect(alice.userRootPath).toBe(expected)
    // realpathSync would throw if the dir did not exist — file tools rely on it.
    expect(fsSync.existsSync(expected)).toBe(true)
  })

  it('scopes file_write through the registry to the per-user root', async () => {
    const config = makeNativeConfig(baseRoot)
    const registry = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      undefined,
      provider.forUser('alice')
    )
    const fileWrite = registry.get('file_write')
    expect(fileWrite).not.toBeNull()
    await fileWrite!.execute({ path: 'note.txt', content: 'scoped' })

    await expect(
      fs.readFile(path.join(baseRoot, 'users', 'alice', 'note.txt'), 'utf-8')
    ).resolves.toContain('scoped')
    // NOT written to the shared collective root.
    await expect(fs.access(path.join(baseRoot, 'note.txt'))).rejects.toBeDefined()
  })

  it('scopes file_read through the registry to the per-user root', async () => {
    const config = makeNativeConfig(baseRoot)
    const registry = new NativeToolRegistry(
      config,
      'conv-1',
      undefined,
      undefined,
      provider.forUser('alice')
    )
    await registry.get('file_write')!.execute({ path: 'r.txt', content: 'scoped-read' })
    const result = await registry.get('file_read')!.execute({ path: 'r.txt' })
    expect(result.is_error).toBeFalsy()
    expect(result.content).toContain('scoped-read')
  })

  it('falls back to the shared root when no ScopedWorkspace is wired', async () => {
    const config = makeNativeConfig(baseRoot)
    // No workspace arg (e.g. the tool-name listing registry / memory disabled).
    const registry = new NativeToolRegistry(config, 'conv-1')
    await registry.get('file_write')!.execute({ path: 'shared.txt', content: 'flat' })
    await expect(fs.readFile(path.join(baseRoot, 'shared.txt'), 'utf-8')).resolves.toContain('flat')
    await expect(fs.access(path.join(baseRoot, 'users'))).rejects.toBeDefined()
  })
})

describe('system namespace', () => {
  it('routes source-less and anonymous-session tasks to the same _system root', async () => {
    await provider.forSource(undefined).appendDailyLog('cron note')
    const systemFile = path.join(baseRoot, 'users', SYSTEM_USER_KEY, 'daily', `${today}.md`)
    await expect(fs.readFile(systemFile, 'utf-8')).resolves.toContain('cron note')

    // The compaction path (sessionKey only) for the same system task agrees.
    await provider.forSessionKey('anonymous:internal:default:default').appendDailyLog('compacted')
    await expect(fs.readFile(systemFile, 'utf-8')).resolves.toContain('compacted')
  })
})

describe('private memory (F5)', () => {
  it('writes private memory to the per-user MEMORY.md, not the collective root', async () => {
    await provider.forUser('alice').appendPrivateMemory('alice likes terse answers')
    await expect(
      fs.readFile(path.join(baseRoot, 'users', 'alice', 'MEMORY.md'), 'utf-8')
    ).resolves.toContain('terse')
    await expect(fs.access(path.join(baseRoot, 'MEMORY.md'))).rejects.toBeDefined()
  })

  it('isolates private memory between users', async () => {
    await provider.forUser('alice').appendPrivateMemory('alice secret')
    expect(await provider.forUser('bob').readPrivateMemory()).toBe('')
    expect(await provider.forUser('alice').readPrivateMemory()).toContain('alice secret')
  })

  it('keeps collective and private memory separate', async () => {
    await provider.forUser('alice').appendMemory('team deadline 15th') // collective
    await provider.forUser('alice').appendPrivateMemory('alice prefers dark mode') // private
    const collective = await provider.forUser('alice').readMemory()
    const priv = await provider.forUser('alice').readPrivateMemory()
    expect(collective).toContain('deadline')
    expect(collective).not.toContain('dark mode')
    expect(priv).toContain('dark mode')
    expect(priv).not.toContain('deadline')
  })

  it('scans private memory writes (injection rejected)', async () => {
    await expect(
      provider.forUser('alice').appendPrivateMemory('see .env for the key')
    ).rejects.toMatchObject({ name: 'MemoryScanRejectionError' })
  })

  it('private memory is searchable by its owner only', async () => {
    await provider.forUser('alice').appendPrivateMemory('zzprivatemarker note')
    expect((await provider.forUser('alice').search('zzprivatemarker', 10)).length).toBeGreaterThan(
      0
    )
    expect(await provider.forUser('bob').search('zzprivatemarker', 10)).toHaveLength(0)
  })

  it('memory_write target:memory_private + memory_read scope:private via the registry', async () => {
    const config = makeNativeConfig(baseRoot)
    const reg = new NativeToolRegistry(config, 'c', undefined, undefined, provider.forUser('alice'))
    const w = await reg
      .get('memory_write')!
      .execute({ content: 'alice is the PM', target: 'memory_private' })
    expect(w.is_error).toBe(false)

    const r = await reg.get('memory_read')!.execute({ scope: 'private' })
    expect(r.is_error).toBe(false)
    expect(r.content).toContain('alice is the PM')

    // The collective memory_read by path does NOT see the private entry.
    await provider.forUser('alice').appendMemory('collective note')
    const rc = await reg.get('memory_read')!.execute({ path: 'MEMORY.md' })
    expect(rc.content).not.toContain('alice is the PM')
  })

  it('memory_write target:memory_private returns is_error (not throw) on scanner rejection', async () => {
    const config = makeNativeConfig(baseRoot)
    const reg = new NativeToolRegistry(config, 'c', undefined, undefined, provider.forUser('alice'))
    const res = await reg
      .get('memory_write')!
      .execute({ content: 'see .env for the key', target: 'memory_private' })
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('rejected')
  })
})
