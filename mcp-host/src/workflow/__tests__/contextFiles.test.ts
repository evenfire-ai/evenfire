import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  contextFilesList,
  contextFilesRead,
  loadContextFilesMounts,
  resolveVirtualPath,
} from '../contextFiles'

let teamRoot: string
let supportRoot: string

beforeEach(() => {
  teamRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-team-'))
  supportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-support-'))
  fs.writeFileSync(path.join(teamRoot, 'mission.md'), '# mission\n')
  fs.mkdirSync(path.join(teamRoot, 'docs'))
  fs.writeFileSync(path.join(teamRoot, 'docs', 'runbook.md'), 'runbook contents\n')
  fs.symlinkSync('mission.md', path.join(teamRoot, 'docs', 'shortcut.md'))
  fs.writeFileSync(path.join(supportRoot, 'faqs.md'), 'q1: ...\n')

  process.env.CLERUM_CONTEXT_FILES_MOUNTS = JSON.stringify([
    { name: 'team-mission', namespace: 'mcp-host', mountPath: teamRoot, pvcName: 'sfs-x' },
    { name: 'support-faqs', namespace: 'mcp-host', mountPath: supportRoot, pvcName: 'sfs-y' },
  ])
})

afterEach(() => {
  delete process.env.CLERUM_CONTEXT_FILES_MOUNTS
  delete process.env.CLERUM_CONTEXT_FILES_MAX_READ_BYTES
  fs.rmSync(teamRoot, { recursive: true, force: true })
  fs.rmSync(supportRoot, { recursive: true, force: true })
})

describe('loadContextFilesMounts', () => {
  it('parses + sorts entries from the env JSON', () => {
    const mounts = loadContextFilesMounts()
    expect(mounts.map(m => m.name)).toEqual(['support-faqs', 'team-mission'])
  })

  it('returns [] for missing env', () => {
    delete process.env.CLERUM_CONTEXT_FILES_MOUNTS
    expect(loadContextFilesMounts()).toEqual([])
  })

  it('returns [] for malformed JSON', () => {
    process.env.CLERUM_CONTEXT_FILES_MOUNTS = '{not json'
    expect(loadContextFilesMounts()).toEqual([])
  })

  it('skips entries missing required keys', () => {
    process.env.CLERUM_CONTEXT_FILES_MOUNTS = JSON.stringify([
      { name: 'ok', namespace: 'n', mountPath: '/m', pvcName: 'p' },
      { name: 'broken' }, // missing keys
    ])
    expect(loadContextFilesMounts().map(m => m.name)).toEqual(['ok'])
  })
})

describe('resolveVirtualPath', () => {
  const mounts = [
    {
      name: 'team-mission',
      namespace: 'mcp-host',
      mountPath: '/mnt/team',
      pvcName: 'sfs-x',
    },
  ]

  it('returns null for empty input', () => {
    expect(resolveVirtualPath('', mounts)).toBeNull()
    expect(resolveVirtualPath('/', mounts)).toBeNull()
  })

  it('throws on traversal segments', () => {
    expect(() => resolveVirtualPath('team-mission/../etc', mounts)).toThrow(/invalid/)
  })

  it('throws on backslash and ASCII control characters', () => {
    expect(() => resolveVirtualPath('team-mission/foo\\bar', mounts)).toThrow(/invalid/)
    expect(() => resolveVirtualPath('team-mission/foo\0', mounts)).toThrow(/invalid/)
    expect(() => resolveVirtualPath('team-mission/foo\nbar', mounts)).toThrow(/invalid/)
    expect(() => resolveVirtualPath('team-mission/foo\rbar', mounts)).toThrow(/invalid/)
    expect(() => resolveVirtualPath('team-mission/foo\x7fbar', mounts)).toThrow(/invalid/)
  })

  it('throws on unknown sfs name', () => {
    expect(() => resolveVirtualPath('does-not-exist/x', mounts)).toThrow(/not mounted/)
  })

  it('returns mount + abs + rel for a valid virtual path', () => {
    const r = resolveVirtualPath('team-mission/docs/runbook.md', mounts)
    expect(r).not.toBeNull()
    expect(r!.mount.name).toBe('team-mission')
    expect(r!.absPath).toBe('/mnt/team/docs/runbook.md')
    expect(r!.rel).toBe('docs/runbook.md')
  })

  it('allows the exact mount root when the manifest path has a trailing slash', () => {
    const r = resolveVirtualPath('team-mission', [
      {
        name: 'team-mission',
        namespace: 'mcp-host',
        mountPath: '/mnt/team/',
        pvcName: 'sfs-x',
      },
    ])
    expect(r).not.toBeNull()
    expect(r!.absPath).toBe('/mnt/team')
    expect(r!.rel).toBe('')
  })
})

describe('clerum__context_files_list', () => {
  it('lists mounted SharedFileSystems when path is empty', async () => {
    const r = await contextFilesList.execute({ path: '' }, '/tmp')
    expect(r.success).toBe(true)
    const parsed = JSON.parse(r.content!) as {
      entries: Array<{ name: string; kind: string }>
    }
    expect(parsed.entries.map(e => e.name).sort()).toEqual(['support-faqs', 'team-mission'])
    expect(parsed.entries.every(e => e.kind === 'sharedfilesystem')).toBe(true)
  })

  it('lists files inside an SFS, hiding symlinks', async () => {
    const r = await contextFilesList.execute({ path: 'team-mission/docs' }, '/tmp')
    expect(r.success).toBe(true)
    const parsed = JSON.parse(r.content!) as {
      entries: Array<{ name: string; kind: string }>
    }
    expect(parsed.entries.map(e => e.name)).toContain('runbook.md')
    expect(parsed.entries.map(e => e.name)).not.toContain('shortcut.md') // symlink
  })

  it('errors on unknown SFS', async () => {
    const r = await contextFilesList.execute({ path: 'no-such-sfs' }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not mounted/)
  })

  it('errors on traversal', async () => {
    const r = await contextFilesList.execute({ path: 'team-mission/../etc' }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/invalid/)
  })

  it('errors when target is a file, not a directory', async () => {
    const r = await contextFilesList.execute({ path: 'team-mission/mission.md' }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not a directory/)
  })
})

describe('clerum__context_files_read', () => {
  it('reads a file from the right SFS', async () => {
    const r = await contextFilesRead.execute({ path: 'team-mission/docs/runbook.md' }, '/tmp')
    expect(r.success).toBe(true)
    const parsed = JSON.parse(r.content!) as { content: string; sharedFileSystem: string }
    expect(parsed.content).toBe('runbook contents\n')
    expect(parsed.sharedFileSystem).toBe('team-mission')
  })

  it('allows files larger than 1 MiB by default', async () => {
    const largeContent = 'x'.repeat(1024 * 1024 + 1)
    fs.writeFileSync(path.join(teamRoot, 'large.txt'), largeContent)

    const r = await contextFilesRead.execute({ path: 'team-mission/large.txt' }, '/tmp')

    expect(r.success).toBe(true)
    const parsed = JSON.parse(r.content!) as { content: string; size: number }
    expect(parsed.content).toBe(largeContent)
    expect(parsed.size).toBe(largeContent.length)
  })

  it('rejects files larger than 10 MiB by default', async () => {
    const oversizedPath = path.join(teamRoot, 'oversized.txt')
    fs.writeFileSync(oversizedPath, Buffer.alloc(10 * 1024 * 1024 + 1, 'x'))

    const r = await contextFilesRead.execute({ path: 'team-mission/oversized.txt' }, '/tmp')

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/exceeds CLERUM_CONTEXT_FILES_MAX_READ_BYTES \(10485760\)/)
  })

  it('refuses directories', async () => {
    const r = await contextFilesRead.execute({ path: 'team-mission/docs' }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/directory/)
  })

  it('refuses symlinks', async () => {
    const r = await contextFilesRead.execute({ path: 'team-mission/docs/shortcut.md' }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/symlinks/)
  })

  it('respects the size cap', async () => {
    process.env.CLERUM_CONTEXT_FILES_MAX_READ_BYTES = '4'
    const r = await contextFilesRead.execute({ path: 'team-mission/docs/runbook.md' }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/exceeds CLERUM_CONTEXT_FILES_MAX_READ_BYTES/)
  })

  it('errors on unknown SFS', async () => {
    const r = await contextFilesRead.execute({ path: 'nope/x.md' }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not mounted/)
  })

  it('errors on missing path arg', async () => {
    const r = await contextFilesRead.execute({}, '/tmp')
    expect(r.success).toBe(false)
  })
})
