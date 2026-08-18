import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AUDIT_MAX_BYTES, type AuditEntry, PluginAuditLog, shapeOf } from '../pluginAuditLog.js'

const ENV_KEY = 'testenv-0123456789ab'

let tmpDir: string
let clock: number
let log: PluginAuditLog

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-08-06T10:00:00.000Z',
    userId: 'user-1',
    pluginId: 'ns/plugin',
    capability: 'identity.read',
    outcome: 'allowed',
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-audit-'))
  clock = 1_700_000_000_000
  log = new PluginAuditLog(tmpDir, () => clock)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('shapeOf', () => {
  it('describes an object by field names, never values', () => {
    expect(shapeOf({ email: 'a@example.com', name: 'A' })).toEqual({ fields: ['email', 'name'] })
  })

  it('describes a wrapped list by count as well as field', () => {
    expect(shapeOf({ agents: [1, 2, 3] })).toEqual({ fields: ['agents'], count: 3 })
  })

  it('describes a string by byte length', () => {
    expect(shapeOf('hello')).toEqual({ bytes: 5 })
  })
})

describe('PluginAuditLog', () => {
  it('appends one JSON line per entry, newest first on read', async () => {
    await log.append(ENV_KEY, entry({ capability: 'identity.read' }))
    await log.append(ENV_KEY, entry({ capability: 'org.read' }))
    const entries = await log.read(ENV_KEY)
    expect(entries.map(item => item.capability)).toEqual(['org.read', 'identity.read'])
  })

  it('writes the file 0600', async () => {
    await log.append(ENV_KEY, entry())
    const stat = await fs.stat(path.join(tmpDir, `${ENV_KEY}.jsonl`))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('filters to one user', async () => {
    await log.append(ENV_KEY, entry({ userId: 'user-1' }))
    await log.append(ENV_KEY, entry({ userId: 'user-2' }))
    const entries = await log.read(ENV_KEY, { userId: 'user-1' })
    expect(entries).toHaveLength(1)
  })

  it('survives a torn final line instead of failing the whole read', async () => {
    await log.append(ENV_KEY, entry())
    // A crash mid-append leaves a partial line; one bad line must not cost the
    // user their whole activity history.
    await fs.appendFile(path.join(tmpDir, `${ENV_KEY}.jsonl`), '{"ts":"broken', 'utf8')
    expect(await log.read(ENV_KEY)).toHaveLength(1)
  })

  it('rotates once past the size ceiling and keeps a single generation', async () => {
    const file = path.join(tmpDir, `${ENV_KEY}.jsonl`)
    await fs.writeFile(file, 'x'.repeat(AUDIT_MAX_BYTES + 1), 'utf8')
    await log.append(ENV_KEY, entry())
    const files = await fs.readdir(tmpDir)
    expect(files.sort()).toEqual([`${ENV_KEY}.jsonl`, `${ENV_KEY}.jsonl.1`])
    expect(await log.read(ENV_KEY)).toHaveLength(1)
  })

  it('never throws into the request path when the directory is unusable', async () => {
    const blocked = new PluginAuditLog(path.join(tmpDir, 'file-not-dir'))
    await fs.writeFile(path.join(tmpDir, 'file-not-dir'), 'x', 'utf8')
    // An audit write failure must not turn a legitimate capability call into an
    // error for the plugin.
    await expect(blocked.append(ENV_KEY, entry())).resolves.toBeUndefined()
  })

  it('rejects an envKey that is not the expected shape', async () => {
    await expect(log.read('../../etc/passwd')).resolves.toEqual([])
  })

  it('clears both generations', async () => {
    await log.append(ENV_KEY, entry())
    await fs.writeFile(path.join(tmpDir, `${ENV_KEY}.jsonl.1`), 'old', 'utf8')
    await log.clear(ENV_KEY)
    expect(await fs.readdir(tmpDir)).toEqual([])
  })
})
