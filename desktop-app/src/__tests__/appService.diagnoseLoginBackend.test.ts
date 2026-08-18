import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// config.ts touches the Electron `app` at module load; provide a minimal mock
// with a NON-packaged, ready app so the env-var runtime-config path is active
// (envRuntimeConfigured requires !app.isPackaged).
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/evenfire-test-userdata'),
    isPackaged: false,
    isReady: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
    getName: vi.fn(() => 'Evenfire'),
  },
}))

// The chat store binds to the real filesystem; stub it so importing appService
// never touches Electron userData.
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
}))

const LOCALHOST_EXTERNAL = 'http://127.0.0.1:8091'
const LOCALHOST_RPC = 'http://127.0.0.1:8094'
const REMOTE_EXTERNAL = 'https://api.example.com'
const REMOTE_RPC = 'https://rpc.example.com'

type HealthByUrl = (baseUrl: string) => Promise<{ status: string }>

async function makeService(healthAt: HealthByUrl) {
  vi.resetModules()
  const { AppService } = await import('../appService.js')
  const service = new AppService() as unknown as {
    authClient: { healthAt: ReturnType<typeof vi.fn> }
    diagnoseLoginBackend: () => Promise<unknown>
  }
  service.authClient = { healthAt: vi.fn(healthAt) } as never
  return service
}

/** A probe that answers only for URLs whose host appears in `reachableHosts`. */
function healthReachableFor(...reachableHosts: string[]): HealthByUrl {
  return async (baseUrl: string) => {
    if (reachableHosts.some(host => baseUrl.includes(host))) return { status: 'ok' }
    throw new Error('ECONNREFUSED')
  }
}

describe('AppService.diagnoseLoginBackend', () => {
  const saved = {
    external: process.env.EXTERNAL_REST_API_BASE_URL,
    rpc: process.env.RPC_PROXY_BASE_URL,
    profileUi: process.env.PROFILE_UI_BASE_URL,
  }

  beforeEach(() => {
    delete process.env.PROFILE_UI_BASE_URL
  })

  afterEach(() => {
    for (const [key, value] of [
      ['EXTERNAL_REST_API_BASE_URL', saved.external],
      ['RPC_PROXY_BASE_URL', saved.rpc],
      ['PROFILE_UI_BASE_URL', saved.profileUi],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.resetModules()
  })

  it('offers a switch to Localhost when the active backend is unreachable and localhost is up', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = REMOTE_EXTERNAL
    process.env.RPC_PROXY_BASE_URL = REMOTE_RPC

    const service = await makeService(healthReachableFor('127.0.0.1'))
    const hint = (await service.diagnoseLoginBackend()) as {
      targetOptionId: string
      targetLabel: string
      activeLabel: string
    } | null

    expect(hint).not.toBeNull()
    expect(hint?.targetOptionId).toBe('__localhost__')
    expect(hint?.targetLabel).toBe('Localhost')
    expect(typeof hint?.activeLabel).toBe('string')
    expect(hint?.activeLabel.length).toBeGreaterThan(0)
  })

  it('stays silent when the active backend is reachable (a healthy backend is not a wrong-server)', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = REMOTE_EXTERNAL
    process.env.RPC_PROXY_BASE_URL = REMOTE_RPC

    // Both the remote and localhost answer — the failure was not "wrong server".
    const service = await makeService(healthReachableFor('api.example.com', '127.0.0.1'))
    expect(await service.diagnoseLoginBackend()).toBeNull()
  })

  it('stays silent when localhost is not reachable (nothing to switch to)', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = REMOTE_EXTERNAL
    process.env.RPC_PROXY_BASE_URL = REMOTE_RPC

    // Nothing answers, including localhost.
    const service = await makeService(healthReachableFor())
    expect(await service.diagnoseLoginBackend()).toBeNull()
  })

  it('stays silent and never probes when the app is already on localhost', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = LOCALHOST_EXTERNAL
    process.env.RPC_PROXY_BASE_URL = LOCALHOST_RPC

    const service = await makeService(healthReachableFor('127.0.0.1'))
    expect(await service.diagnoseLoginBackend()).toBeNull()
    expect(service.authClient.healthAt).not.toHaveBeenCalled()
  })
})
