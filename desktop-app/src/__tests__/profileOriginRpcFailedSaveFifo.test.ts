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
it('rejects an old origin after a failed RPC save and same-profile reselection', async () => {
  const h = await createNativeCommitTestHarness()
  const service = h.service as any
  const rpc1 = 'https://rpc-a.example.test',
    rpc2 = 'https://rpc-new.example.test',
    origin = 'https://profile-old.example.test'
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
        rpcProxyBaseUrl: rpc1,
        appName: 'Environment A',
        profileUiBaseUrl: origin,
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
  const realWrite = fs.writeFile.bind(fs)
  let failed = false
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (!failed && args[0] === h.optionA.configPath && String(args[1]).includes(rpc2)) {
      failed = true
      throw Object.assign(new Error('injected write failure'), { code: 'EACCES' })
    }
    return realWrite(...args)
  })
  const owner = vi.spyOn(service, 'withNativeAuthEnvironmentCommit')
  const action = service.openForgotPassword('user@example.test')
  void action.catch(() => undefined)
  let logout: Promise<unknown> | undefined
  let save: Promise<unknown> | undefined
  let select: Promise<unknown> | undefined
  try {
    await entered.promise
    logout = service.logout()
    void logout.catch(() => undefined)
    await ownerHeld.promise
    const beforeSave = owner.mock.calls.length
    save = service.saveRuntimeConfig({
      externalRestApiBaseUrl: h.restA,
      responseUrl: `${h.restA}/api/v1/desktop/environment`,
      rpcProxyBaseUrl: rpc2,
      appName: 'Environment A',
    })
    void save.catch(() => undefined)
    await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeSave))
    const beforeSelect = owner.mock.calls.length
    select = service.selectRuntimeConfig(h.optionA.id)
    void select.catch(() => undefined)
    await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeSelect))
    expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionA.id)
    expect(h.runtimeConfig.config.rpcProxyBaseUrl).toBe(rpc1)
    const beforeAdmission = owner.mock.calls.length
    response.resolve()
    await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeAdmission))
    releaseOwner.resolve()
    const results = await Promise.allSettled([logout!, save!, select!, action])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    if (results[1].status === 'rejected') expect(results[1].reason.code).toBe('EACCES')
    expect(results[2].status).toBe('fulfilled')
    expect(results[3].status).toBe('rejected')
    expect(failed).toBe(true)
    expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionA.id)
    const indexFile = path.join(path.dirname(h.optionA.configPath!), 'index.json')
    expect(JSON.parse(await fs.readFile(indexFile, 'utf8')).activeProfileId).toBe(h.optionA.id)
    expect(h.runtimeConfig.config.rpcProxyBaseUrl).toBe(rpc2)
    const disk = JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))
    expect(disk.rpcProxyBaseUrl).toBe(rpc1)
    expect(disk).not.toHaveProperty('profileUiBaseUrl')
  } finally {
    response.resolve()
    releaseOwner.resolve()
    await Promise.allSettled(
      [logout, save, select, action].filter((operation): operation is Promise<unknown> =>
        Boolean(operation)
      )
    )
  }
}, 15000)
