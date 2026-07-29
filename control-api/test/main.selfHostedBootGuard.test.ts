import { afterEach, describe, expect, it, vi } from 'vitest'
import { logRegistryConnectionState } from '../src/registryBootGuard.js'

// The function lives in a standalone module importing ONLY config, the logger,
// and registryConnectionDb, so this test never pulls in main.ts's full
// server/cron graph.
const { cfg } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'self-hosted',
    registryUrl: 'https://registry.evenfire.ai',
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const connDb = vi.hoisted(() => ({ getRegistryConnection: vi.fn() }))
vi.mock('../src/services/registryConnectionDb.js', () => connDb)

const logger = vi.hoisted(() => ({ rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/observability/logger.js', () => logger)

afterEach(() => {
  vi.clearAllMocks()
  cfg.registryConnectionMode = 'self-hosted'
  cfg.registryUrl = 'https://registry.evenfire.ai'
})

describe('logRegistryConnectionState', () => {
  // The deadlock regression guard. `.resolves` (not `.rejects`) is the detector:
  // if a future change reintroduces a throw here, control-api cannot boot
  // before it has connected, and this test fails.
  it('does NOT throw when self-hosted with no connection row', { retry: 0 }, async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    await expect(logRegistryConnectionState()).resolves.toBeUndefined()
    expect(logger.rootLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ connected: false }),
      expect.any(String)
    )
  })

  it('reports connected for a row holding client credentials', async () => {
    connDb.getRegistryConnection.mockResolvedValue({ status: 'connected', clientId: 'cid' })
    await expect(logRegistryConnectionState()).resolves.toBeUndefined()
    expect(logger.rootLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true }),
      expect.any(String)
    )
  })

  // An auto-approved row whose claim has not landed has no clientId.
  it('reports NOT connected for an approved row with no clientId', async () => {
    connDb.getRegistryConnection.mockResolvedValue({ status: 'approved', clientId: null })
    await logRegistryConnectionState()
    expect(logger.rootLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ connected: false }),
      expect.any(String)
    )
  })

  it('no-op in managed mode — does not even read the row', async () => {
    cfg.registryConnectionMode = 'managed'
    await expect(logRegistryConnectionState()).resolves.toBeUndefined()
    expect(connDb.getRegistryConnection).not.toHaveBeenCalled()
    expect(logger.rootLogger.info).not.toHaveBeenCalled()
  })

  it('no-op when no registry URL is configured', async () => {
    cfg.registryUrl = ''
    await expect(logRegistryConnectionState()).resolves.toBeUndefined()
    expect(connDb.getRegistryConnection).not.toHaveBeenCalled()
  })
})
