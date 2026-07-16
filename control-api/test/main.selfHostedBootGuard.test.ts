import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertRegistryConnectionReady } from '../src/registryBootGuard.js'

// C-M5: the guard lives in a standalone module (src/registryBootGuard.ts) that
// imports ONLY config + registryConnectionDb, so this test never pulls in
// main.ts's full server/cron graph.
const { cfg } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'self-hosted',
    registryAuthEnabled: true,
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const connDb = vi.hoisted(() => ({ getRegistryConnection: vi.fn() }))
vi.mock('../src/services/registryConnectionDb.js', () => connDb)

afterEach(() => {
  vi.clearAllMocks()
  cfg.registryConnectionMode = 'self-hosted'
  cfg.registryAuthEnabled = true
})

describe('assertRegistryConnectionReady (self-hosted boot guard)', () => {
  it('throws when self-hosted + enabled + no connection row', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    await expect(assertRegistryConnectionReady()).rejects.toThrow(/registry_connection/)
  })

  it('passes when a connected row exists', async () => {
    connDb.getRegistryConnection.mockResolvedValue({ status: 'connected' })
    await expect(assertRegistryConnectionReady()).resolves.toBeUndefined()
  })

  it('no-op when registry auth is disabled', async () => {
    cfg.registryAuthEnabled = false
    connDb.getRegistryConnection.mockResolvedValue(null)
    await expect(assertRegistryConnectionReady()).resolves.toBeUndefined()
  })

  it('no-op in managed mode', async () => {
    cfg.registryConnectionMode = 'managed'
    connDb.getRegistryConnection.mockResolvedValue(null)
    await expect(assertRegistryConnectionReady()).resolves.toBeUndefined()
  })
})
