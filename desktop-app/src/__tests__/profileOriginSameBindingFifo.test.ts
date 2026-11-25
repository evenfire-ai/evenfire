import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupNativeCommitTestHarness()
})

it('rejects P write after queued Q selection when both indexed records share REST and RPC', async () => {
  const h = await createNativeCommitTestHarness()
  const rpc = 'https://rpc-a.example.test'
  await fs.writeFile(
    h.optionB.configPath!,
    JSON.stringify({
      externalRestApiBaseUrl: h.restA,
      responseUrl: `${h.restA}/api/v1/desktop/environment`,
      rpcProxyBaseUrl: rpc,
      appName: 'Environment B',
    })
  )
  vi.resetModules()
  const [{ AppService }, config] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  const state = config.getDesktopRuntimeConfigState()
  expect(state.activeOptionId).toBe(h.optionA.id)
  expect(state.options.find(o => o.id === h.optionB.id)?.externalRestApiBaseUrl).toBe(h.restA)
  expect(state.options.find(o => o.id === h.optionB.id)?.rpcProxyBaseUrl).toBe(rpc)
  const service = new AppService() as any
  const response = deferred<void>(),
    entered = deferred<void>(),
    ownerHeld = deferred<void>(),
    releaseOwner = deferred<void>()
  service.authClient = {
    getDesktopEnvironmentForEndpoint: vi.fn(() => {
      entered.resolve()
      return response.promise.then(() => ({
        externalRestApiBaseUrl: h.restA,
        responseUrl: `${h.restA}/api/v1/desktop/environment`,
        rpcProxyBaseUrl: rpc,
        appName: 'Environment A',
        profileUiBaseUrl: 'https://profile-a.example.test',
      }))
    }),
  }
  service.suspendDesktopGfsUploadsForAuthBoundary = vi
    .fn()
    .mockImplementationOnce(() => {
      ownerHeld.resolve()
      return releaseOwner.promise
    })
    .mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  const owner = vi.spyOn(service, 'withNativeAuthEnvironmentCommit')
  const action = service.openForgotPassword('user@example.test')
  void action.catch(() => undefined)
  let logout: Promise<unknown> | undefined
  let selection: Promise<unknown> | undefined
  try {
    await entered.promise
    logout = service.logout()
    void logout.catch(() => undefined)
    await ownerHeld.promise
    const beforeSelection = owner.mock.calls.length
    selection = service.selectRuntimeConfig(h.optionB.id)
    void selection.catch(() => undefined)
    await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeSelection))
    expect(config.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionA.id)
    const beforeAdmission = owner.mock.calls.length
    response.resolve()
    await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeAdmission))
    releaseOwner.resolve()
    const results = await Promise.allSettled([logout!, selection!, action])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('fulfilled')
    expect(results[2].status).toBe('rejected')
    expect(config.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionB.id)
    const indexFile = path.join(path.dirname(h.optionA.configPath!), 'index.json')
    expect(JSON.parse(await fs.readFile(indexFile, 'utf8')).activeProfileId).toBe(h.optionB.id)
    expect(JSON.parse(await fs.readFile(h.optionB.configPath!, 'utf8'))).not.toHaveProperty(
      'profileUiBaseUrl'
    )
    expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))).not.toHaveProperty(
      'profileUiBaseUrl'
    )
  } finally {
    response.resolve()
    releaseOwner.resolve()
    await Promise.allSettled(
      [logout, selection, action].filter((operation): operation is Promise<unknown> =>
        Boolean(operation)
      )
    )
  }
}, 15000)
