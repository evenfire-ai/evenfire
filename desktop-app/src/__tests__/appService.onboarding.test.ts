import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn(async (_url: string) => undefined)

// config.ts touches the Electron `app` at module load; provide a minimal mock
// with a NON-packaged, ready app so the env-var runtime-config path is active.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/evenfire-test-userdata'),
    isPackaged: false,
    isReady: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
    getName: vi.fn(() => 'Evenfire'),
  },
  shell: { openExternal },
}))

// The chat store binds to the real filesystem; stub it so importing appService
// never touches Electron userData.
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
}))

const LOCALHOST_EXTERNAL = 'http://127.0.0.1:8091'
const REMOTE_EXTERNAL = 'https://api.example.com'
const REMOTE_RPC = 'https://rpc.example.com'

type HealthByUrl = (baseUrl: string) => Promise<{ status: string }>

async function makeService(healthAt: HealthByUrl) {
  vi.resetModules()
  const { AppService } = await import('../appService.js')
  const service = new AppService() as unknown as {
    authClient: { healthAt: ReturnType<typeof vi.fn> }
    probeLocalhostReachable: () => Promise<boolean>
    openDeploymentDocs: () => Promise<{ opened: true }>
  }
  service.authClient = { healthAt: vi.fn(healthAt) } as never
  return service
}

function healthReachableFor(...reachableHosts: string[]): HealthByUrl {
  return async (baseUrl: string) => {
    if (reachableHosts.some(host => baseUrl.includes(host))) return { status: 'ok' }
    throw new Error('ECONNREFUSED')
  }
}

describe('onboarding main-process surface', () => {
  const saved = {
    external: process.env.EXTERNAL_REST_API_BASE_URL,
    rpc: process.env.RPC_PROXY_BASE_URL,
    docs: process.env.DEPLOYMENT_DOCS_URL,
  }

  beforeEach(() => {
    openExternal.mockClear()
    delete process.env.DEPLOYMENT_DOCS_URL
  })

  afterEach(() => {
    for (const [key, value] of [
      ['EXTERNAL_REST_API_BASE_URL', saved.external],
      ['RPC_PROXY_BASE_URL', saved.rpc],
      ['DEPLOYMENT_DOCS_URL', saved.docs],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.resetModules()
  })

  describe('probeLocalhostReachable', () => {
    it('reports a reachable local cluster', async () => {
      process.env.EXTERNAL_REST_API_BASE_URL = REMOTE_EXTERNAL
      process.env.RPC_PROXY_BASE_URL = REMOTE_RPC

      const service = await makeService(healthReachableFor('127.0.0.1'))

      expect(await service.probeLocalhostReachable()).toBe(true)
    })

    it('reports false when nothing answers, rather than throwing', async () => {
      process.env.EXTERNAL_REST_API_BASE_URL = REMOTE_EXTERNAL
      process.env.RPC_PROXY_BASE_URL = REMOTE_RPC

      const service = await makeService(healthReachableFor())

      expect(await service.probeLocalhostReachable()).toBe(false)
    })

    it('only ever probes the localhost option, whatever the active environment', async () => {
      process.env.EXTERNAL_REST_API_BASE_URL = REMOTE_EXTERNAL
      process.env.RPC_PROXY_BASE_URL = REMOTE_RPC

      const service = await makeService(healthReachableFor('127.0.0.1'))
      await service.probeLocalhostReachable()

      // The renderer cannot name a URL for the main process to fetch, so the
      // remote environment must never be contacted by this call (spec §6.8).
      expect(service.authClient.healthAt).toHaveBeenCalledTimes(1)
      expect(service.authClient.healthAt.mock.calls[0]?.[0]).toBe(LOCALHOST_EXTERNAL)
    })
  })

  describe('openDeploymentDocs', () => {
    it('opens the build-time documentation URL, taking no argument', async () => {
      const service = await makeService(healthReachableFor())

      expect(await service.openDeploymentDocs()).toEqual({ opened: true })
      expect(openExternal).toHaveBeenCalledTimes(1)

      const opened = String(openExternal.mock.calls[0]?.[0] || '')
      expect(opened).toMatch(/^https:\/\//)
      // Self-hosting covers any cluster the user controls, so the link must not
      // land on the local-cluster quickstart (spec §5.4).
      expect(opened).not.toMatch(/minikube|quickstart/i)
    })
  })
})
