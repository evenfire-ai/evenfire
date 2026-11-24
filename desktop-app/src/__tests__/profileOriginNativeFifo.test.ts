import { afterEach, expect, it, vi } from 'vitest'
import fc from 'fast-check'
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

it('rejects P origin admission after the earlier queued selection of Q', async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), async scheduler => {
      const h = await createNativeCommitTestHarness()
      const service = h.service as unknown as {
        authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
        openForgotPassword: (email: string) => Promise<unknown>
        logout: () => Promise<unknown>
        selectRuntimeConfig: (id: string) => Promise<unknown>
        withNativeAuthEnvironmentCommit: (fn: () => Promise<unknown>) => Promise<unknown>
        suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
        stopAllStreams: () => void
      }
      const response = deferred<void>()
      const entered = deferred<void>()
      const ownerHeld = deferred<void>()
      const releaseOwner = deferred<void>()
      service.authClient = {
        getDesktopEnvironmentForEndpoint: vi.fn(() => {
          entered.resolve()
          return response.promise.then(() =>
            scheduler.schedule(
              Promise.resolve({
                externalRestApiBaseUrl: h.restA,
                responseUrl: `${h.restA}/api/v1/desktop/environment`,
                rpcProxyBaseUrl: 'https://rpc-a.example.test',
                appName: 'Environment A',
                profileUiBaseUrl: 'https://profile-authority.example.test',
              }),
              'P REST response'
            )
          )
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
      await entered.promise
      const logout = service.logout()
      void logout.catch(() => undefined)
      await ownerHeld.promise
      const beforeSelection = owner.mock.calls.length
      const selection = service.selectRuntimeConfig(h.optionB.id)
      void selection.catch(() => undefined)
      try {
        await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeSelection))
        expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionA.id)
        const beforeAdmission = owner.mock.calls.length
        response.resolve()
        await Promise.resolve()
        await scheduler.waitAll()
        await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeAdmission))
        expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))).not.toHaveProperty(
          'profileUiBaseUrl'
        )
        releaseOwner.resolve()
        const results = await Promise.allSettled([logout, selection, action])
        expect(results[0].status).toBe('fulfilled')
        expect(results[1].status).toBe('fulfilled')
        expect(results[2].status).toBe('rejected')
        expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionB.id)
        expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))).not.toHaveProperty(
          'profileUiBaseUrl'
        )
      } finally {
        response.resolve()
        releaseOwner.resolve()
        await scheduler.waitAll()
        await Promise.allSettled([logout, selection, action])
        await cleanupNativeCommitTestHarness()
      }
    }),
    { seed: 146350, numRuns: 1, endOnFailure: true }
  )
}, 15000)

it('does not start a Q lookup for an App share captured under P', async () => {
  const h = await createNativeCommitTestHarness()
  const service = h.service as unknown as {
    authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
    sessionToken: string | null
    me: { id: string } | null
    selectRuntimeConfig: (id: string) => Promise<unknown>
    createSandboxUiDeepLink: () => Promise<unknown>
    suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    stopAllStreams: () => void
  }
  service.sessionToken = 'synthetic-session'
  service.me = { id: 'user-1' }
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  const held = deferred<{
    externalRestApiBaseUrl: string
    responseUrl: string
    rpcProxyBaseUrl: string
    appName: string
    profileUiBaseUrl: string
  }>()
  const discovery = vi.fn(() => held.promise)
  service.authClient = { getDesktopEnvironmentForEndpoint: discovery }
  let selection: Promise<unknown> | undefined
  const driver = await import('../sandboxUiDriver.js')
  vi.spyOn(driver, 'getActiveSandboxUiLocation').mockImplementation(() => {
    selection = service.selectRuntimeConfig(h.optionB.id)
    void selection.catch(() => undefined)
    return { recipeNs: 'sandbox-recipes', recipeName: 'task-board', path: '/tasks/42' }
  })
  const action = service.createSandboxUiDeepLink()
  void action.catch(() => undefined)
  await vi.waitFor(() => expect(selection).toBeDefined())
  await selection
  held.resolve({
    externalRestApiBaseUrl: h.restA,
    responseUrl: `${h.restA}/api/v1/desktop/environment`,
    rpcProxyBaseUrl: 'https://rpc-a.example.test',
    appName: 'Environment A',
    profileUiBaseUrl: 'https://profile-a.example.test',
  })
  const result = await Promise.allSettled([action])
  expect(result[0].status).toBe('rejected')
  expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionB.id)
  expect(discovery).not.toHaveBeenCalledWith(h.restB)
  expect(JSON.parse(await fs.readFile(h.optionB.configPath!, 'utf8'))).not.toHaveProperty(
    'profileUiBaseUrl'
  )
}, 15000)

it('finishes an admitted P file write before a later Q selection', async () => {
  const h = await createNativeCommitTestHarness()
  const service = h.service as unknown as {
    authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
    openForgotPassword: (email: string) => Promise<unknown>
    selectRuntimeConfig: (id: string) => Promise<unknown>
    suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    stopAllStreams: () => void
  }
  const origin = 'https://profile-authority.example.test'
  service.authClient = {
    getDesktopEnvironmentForEndpoint: vi.fn().mockResolvedValue({
      externalRestApiBaseUrl: h.restA,
      responseUrl: `${h.restA}/api/v1/desktop/environment`,
      rpcProxyBaseUrl: 'https://rpc-a.example.test',
      appName: 'Environment A',
      profileUiBaseUrl: origin,
    }),
  }
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  const enteredWrite = deferred<void>()
  const releaseWrite = deferred<void>()
  const writeFile = fs.writeFile.bind(fs)
  let held = false
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (args[0] === h.optionA.configPath && String(args[1]).includes(origin) && !held) {
      held = true
      enteredWrite.resolve()
      await releaseWrite.promise
    }
    return writeFile(...args)
  })
  const action = service.openForgotPassword('user@example.test')
  void action.catch(() => undefined)
  let selection: Promise<unknown> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('file-write schedule did not settle')), 3000)
    })
    await Promise.race([enteredWrite.promise, deadline])
    selection = service.selectRuntimeConfig(h.optionB.id)
    let selected = false
    void selection.then(
      () => {
        selected = true
      },
      () => {
        selected = true
      }
    )
    await Promise.resolve()
    expect(selected).toBe(false)
    expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionA.id)
    expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))).not.toHaveProperty(
      'profileUiBaseUrl'
    )
    releaseWrite.resolve()
    const results = await Promise.race([Promise.allSettled([action, selection]), deadline])
    expect(results[1].status).toBe('fulfilled')
    if (results[0].status === 'fulfilled') {
      expect(results[0].value).toEqual({
        profileUiUrl: `${origin}/forgot-password?email=user%40example.test`,
      })
    } else {
      expect(String(results[0].reason)).toContain('Profile UI deployment changed')
    }
    expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionB.id)
    const indexFile = path.join(path.dirname(h.optionA.configPath!), 'index.json')
    expect(JSON.parse(await fs.readFile(indexFile, 'utf8')).activeProfileId).toBe(h.optionB.id)
    expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8')).profileUiBaseUrl).toBe(
      origin
    )
  } finally {
    if (timer) clearTimeout(timer)
    releaseWrite.resolve()
    await Promise.allSettled([action, ...(selection ? [selection] : [])])
  }
}, 15000)

it.each(['app', 'gfs'] as const)(
  'rejects a %s share when the same-origin RPC path changes before final admission',
  async kind => {
    const h = await createNativeCommitTestHarness()
    const rpc1 = 'https://rpc-a.example.test/r1'
    const rpc2 = 'https://rpc-a.example.test/r2'
    const origin = 'https://profile-a.example.test'
    await h.runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: h.restA,
      rpcProxyBaseUrl: rpc1,
      appName: 'Environment A',
    })
    await h.runtimeConfig.persistProfileOriginForBinding(
      h.runtimeConfig.captureProfileOriginBinding(),
      origin
    )
    const service = h.service as any
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1' }
    const generation = service.sessionGeneration
    const enteredWrite = deferred<void>()
    const releaseWrite = deferred<void>()
    const writeFile = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (args[0] === h.optionA.configPath && String(args[1]).includes(rpc2)) {
        enteredWrite.resolve()
        await releaseWrite.promise
      }
      return writeFile(...args)
    })
    const owner = vi.spyOn(service, 'withNativeAuthEnvironmentCommit')
    let save: Promise<unknown> | undefined
    const enqueueSave = () => {
      save = service.saveRuntimeConfig({
        externalRestApiBaseUrl: h.restA,
        rpcProxyBaseUrl: rpc2,
        appName: 'Environment A',
      })
      void save.catch(() => undefined)
    }
    if (kind === 'app') {
      const driver = await import('../sandboxUiDriver.js')
      vi.spyOn(driver, 'getActiveSandboxUiLocation').mockImplementation(() => {
        enqueueSave()
        return { recipeNs: 'sandbox-recipes', recipeName: 'task-board', path: '/tasks/42' }
      })
    } else {
      const gfs = await import('../gfsDeepLinks.js')
      const normalize = gfs.normalizeGfsResourceUri
      vi.spyOn(gfs, 'normalizeGfsResourceUri').mockImplementation(uri => {
        enqueueSave()
        return normalize(uri)
      })
    }
    const action =
      kind === 'app'
        ? service.createSandboxUiDeepLink()
        : service.createGfsResourceDeepLink('gfs://main/0123456789abcdef0123456789abcdef')
    void action.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RPC rebind schedule timed out')), 3000)
      })
      await Promise.race([enteredWrite.promise, deadline])
      await Promise.race([
        vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThanOrEqual(3)),
        deadline,
      ])
      expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionA.id)
      expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8')).rpcProxyBaseUrl).toBe(
        rpc1
      )
      releaseWrite.resolve()
      const [saveResult, actionResult] = await Promise.race([
        Promise.allSettled([save!, action]),
        deadline,
      ])
      expect(saveResult.status).toBe('fulfilled')
      expect(service.sessionGeneration).toBe(generation)
      expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8')).rpcProxyBaseUrl).toBe(
        rpc2
      )
      expect(actionResult.status).toBe('rejected')
    } finally {
      if (timer) clearTimeout(timer)
      releaseWrite.resolve()
      await Promise.allSettled([...(save ? [save] : []), action])
    }
  },
  15000
)
