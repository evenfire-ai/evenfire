import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ConsentGrant, LocalConsentStore } from '../pluginConsentStore.js'

const ENV_A = 'enva-0123456789ab'
const ENV_B = 'envb-0123456789ab'

let tmpDir: string
let store: LocalConsentStore

function grant(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return {
    envKey: ENV_A,
    userId: 'user-1',
    pluginId: 'ns/plugin',
    capability: 'identity.read',
    grantedAt: '2026-08-06T10:00:00.000Z',
    lastUsedAt: null,
    descriptorVersion: 1,
    revision: 0,
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-consent-store-'))
  store = new LocalConsentStore(tmpDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('LocalConsentStore', () => {
  it('round-trips a grant through a fresh instance', async () => {
    await store.put(grant())
    const reread = new LocalConsentStore(tmpDir)
    const found = await reread.get({
      envKey: ENV_A,
      userId: 'user-1',
      pluginId: 'ns/plugin',
      capability: 'identity.read',
    })
    expect(found?.capability).toBe('identity.read')
    expect(found?.revision).toBe(1)
  })

  it('writes the file 0600 so other local accounts cannot read it', async () => {
    await store.put(grant())
    const stat = await fs.stat(path.join(tmpDir, `${ENV_A}.json`))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('keeps environments apart', async () => {
    await store.put(grant({ envKey: ENV_A }))
    const other = await store.get({
      envKey: ENV_B,
      userId: 'user-1',
      pluginId: 'ns/plugin',
      capability: 'identity.read',
    })
    // Cluster A's grants must never answer for cluster B.
    expect(other).toBeNull()
  })

  it('keeps users on one machine apart', async () => {
    await store.put(grant({ userId: 'user-1' }))
    const other = await store.get({
      envKey: ENV_A,
      userId: 'user-2',
      pluginId: 'ns/plugin',
      capability: 'identity.read',
    })
    expect(other).toBeNull()
  })

  it('rejects an envKey that is not the expected shape', async () => {
    await expect(store.list('../../etc', 'user-1')).rejects.toThrow(/envKey/)
  })

  it('bumps revision on re-grant instead of duplicating the row', async () => {
    await store.put(grant())
    await store.put(grant())
    const rows = await store.list(ENV_A, 'user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.revision).toBe(2)
  })

  it('records last use without disturbing the grant', async () => {
    await store.put(grant())
    await store.touch({
      envKey: ENV_A,
      userId: 'user-1',
      pluginId: 'ns/plugin',
      capability: 'identity.read',
    })
    const rows = await store.list(ENV_A, 'user-1')
    expect(rows[0]?.lastUsedAt).toEqual(expect.any(String))
    expect(rows[0]?.grantedAt).toBe('2026-08-06T10:00:00.000Z')
  })

  it('revokes one capability and leaves the rest', async () => {
    await store.put(grant({ capability: 'identity.read' }))
    await store.put(grant({ capability: 'org.read' }))
    await store.revoke({
      envKey: ENV_A,
      userId: 'user-1',
      pluginId: 'ns/plugin',
      capability: 'identity.read',
    })
    const rows = await store.list(ENV_A, 'user-1')
    expect(rows.map(row => row.capability)).toEqual(['org.read'])
  })

  it('revokes everything for one plugin without touching another', async () => {
    await store.put(grant({ pluginId: 'ns/a' }))
    await store.put(grant({ pluginId: 'ns/a', capability: 'org.read' }))
    await store.put(grant({ pluginId: 'ns/b' }))
    await store.revokeAllForPlugin(ENV_A, 'user-1', 'ns/a')
    const rows = await store.list(ENV_A, 'user-1')
    expect(rows.map(row => row.pluginId)).toEqual(['ns/b'])
  })

  it('prunes grants for plugins the user can no longer reach', async () => {
    await store.put(grant({ pluginId: 'ns/gone' }))
    await store.put(grant({ pluginId: 'ns/kept' }))
    await store.pruneToPlugins(ENV_A, 'user-1', new Set(['ns/kept']))
    const rows = await store.list(ENV_A, 'user-1')
    expect(rows.map(row => row.pluginId)).toEqual(['ns/kept'])
  })

  it('fails CLOSED on a corrupt file and moves it aside', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await fs.writeFile(path.join(tmpDir, `${ENV_A}.json`), '{ not json', 'utf8')
    // A half-understood grant list is worse than none: every capability
    // re-prompts rather than being silently mis-read.
    const rows = await store.list(ENV_A, 'user-1')
    expect(rows).toEqual([])
    const files = await fs.readdir(tmpDir)
    expect(files.some(file => file.includes('.corrupt-'))).toBe(true)
  })

  it('fails CLOSED on a file from a newer schema version', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await fs.writeFile(
      path.join(tmpDir, `${ENV_A}.json`),
      JSON.stringify({ version: 99, users: { 'user-1': [grant()] } }),
      'utf8'
    )
    expect(await store.list(ENV_A, 'user-1')).toEqual([])
  })

  it('serializes concurrent writes without losing one', async () => {
    await Promise.all([
      store.put(grant({ capability: 'identity.read' })),
      store.put(grant({ capability: 'org.read' })),
      store.put(grant({ capability: 'agents.read' })),
    ])
    const rows = await store.list(ENV_A, 'user-1')
    expect(rows.map(row => row.capability).sort()).toEqual([
      'agents.read',
      'identity.read',
      'org.read',
    ])
  })

  it('leaves no temp file behind after a write', async () => {
    await store.put(grant())
    const files = await fs.readdir(tmpDir)
    expect(files.filter(file => file.includes('.tmp-'))).toEqual([])
  })
})
