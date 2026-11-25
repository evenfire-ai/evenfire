import { afterEach, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
const saved = {
  path: process.env.CLERUM_DESKTOP_CONFIG_PATH,
  rest: process.env.EXTERNAL_REST_API_BASE_URL,
  rpc: process.env.RPC_PROXY_BASE_URL,
  profile: process.env.PROFILE_UI_BASE_URL,
}
const dirs = new Set<string>()
async function cleanup() {
  for (const [key, value] of Object.entries({
    CLERUM_DESKTOP_CONFIG_PATH: saved.path,
    EXTERNAL_REST_API_BASE_URL: saved.rest,
    RPC_PROXY_BASE_URL: saved.rpc,
    PROFILE_UI_BASE_URL: saved.profile,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  await Promise.all([...dirs].map(dir => fs.rm(dir, { recursive: true, force: true })))
  dirs.clear()
}
afterEach(cleanup)
const rest = 'https://api-a.example.test',
  rpc = 'https://rpc-a.example.test',
  origin = 'https://profile-unique.example.test'
type Model = { state: 'idle' | 'pending' | 'complete' }
type Actual = {
  file: string
  scheduler: fc.Scheduler
  get: ReturnType<typeof vi.fn>
  service: { passwordLogin: (email: string, pass: string) => Promise<unknown> }
  cfg: { getDesktopRuntimeConfigState: () => { activeOptionId: string | null } }
  action?: Promise<unknown>
}
let completed = 0
class Start implements fc.AsyncCommand<Model, Actual> {
  check(m: Readonly<Model>) {
    return m.state === 'idle'
  }
  async run(m: Model, a: Actual) {
    a.action = a.service.passwordLogin('user@example.test', 'synthetic-password')
    void a.action.catch(() => undefined)
    await vi.waitFor(() => expect(a.get).toHaveBeenCalledOnce())
    m.state = 'pending'
  }
  toString() {
    return 'begin-same-record-rpc-enrichment'
  }
}
class Settle implements fc.AsyncCommand<Model, Actual> {
  check(m: Readonly<Model>) {
    return m.state === 'pending'
  }
  async run(m: Model, a: Actual) {
    const result = await a.scheduler.waitFor(
      a.action!.then(
        () => 'unexpected success',
        error => (error as Error).message
      )
    )
    expect(result).toContain('login rejected for test')
    const file = JSON.parse(await fs.readFile(a.file, 'utf8'))
    expect(file.externalRestApiBaseUrl).toBe(rest)
    expect(file.rpcProxyBaseUrl).toBe(rpc)
    expect(file.profileUiBaseUrl).toBe(origin)
    expect(a.cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
    m.state = 'complete'
    completed++
  }
  toString() {
    return 'settle-rpc-enrichment-and-compare-disk'
  }
}
it('models same-record RPC enrichment at a real scheduled REST await', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.commands([fc.constant(new Start()), fc.constant(new Settle())], { maxCommands: 12 }),
      async (scheduler, commands) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-model-enrich-'))
        dirs.add(dir)
        const file = path.join(dir, 'runtime.json')
        await fs.writeFile(
          file,
          JSON.stringify({
            externalRestApiBaseUrl: rest,
            rpcProxyBaseUrl: '',
            appName: 'A',
            profileUiBaseUrl: origin,
          })
        )
        process.env.CLERUM_DESKTOP_CONFIG_PATH = file
        delete process.env.EXTERNAL_REST_API_BASE_URL
        delete process.env.RPC_PROXY_BASE_URL
        delete process.env.PROFILE_UI_BASE_URL
        vi.resetModules()
        vi.doMock('electron', () => ({
          app: {
            getPath: () => dir,
            isPackaged: false,
            isReady: () => true,
            setName: vi.fn(),
            setPath: vi.fn(),
          },
          shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
        }))
        const [{ AppService }, cfg] = await Promise.all([
          import('../appService.js'),
          import('../config.js'),
        ])
        const service = new AppService() as unknown as Actual['service'] & { authClient: unknown }
        const get = vi.fn(() =>
          scheduler.schedule(
            Promise.resolve({
              externalRestApiBaseUrl: rest,
              responseUrl: `${rest}/api/v1/desktop/environment`,
              rpcProxyBaseUrl: rpc,
              appName: 'A',
            }),
            'verified RPC discovery'
          )
        )
        service.authClient = {
          getDesktopEnvironment: get,
          getDesktopEnvironmentForEndpoint: get,
          passwordLogin: vi.fn().mockRejectedValue(new Error('login rejected for test')),
        }
        const model: Model = { state: 'idle' }
        const actual: Actual = { file, scheduler, get, service, cfg }
        try {
          await fc.asyncModelRun(() => ({ model, real: actual }), commands)
          if (model.state === 'pending') await new Settle().run(model, actual)
        } finally {
          await scheduler.waitAll()
          if (actual.action) await actual.action.catch(() => undefined)
          await cleanup()
        }
      }
    ),
    { seed: 146351, numRuns: 100, endOnFailure: true }
  )
  expect(completed).toBeGreaterThan(0)
}, 60000)
