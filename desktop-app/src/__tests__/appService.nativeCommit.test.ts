import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { saveGfsReceiptToPath } from '../gfs/saveOwner.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService native auth and environment commit ordering', () => {
  it('keeps Copy ID inside the local authority queue and rejects stale generations', async () => {
    const { service } = await createNativeCommitTestHarness()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me }),
    } as never
    await service.googleLogin('synthetic-google-token')

    const app = service as unknown as {
      tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }
      getSessionGeneration(): number
    }
    const originalClear = app.tokenStore.clearSessionToken
    const order: string[] = []
    app.tokenStore.clearSessionToken = vi.fn(async (...args: unknown[]) => {
      order.push('logout-commit')
      await originalClear(...args)
    })
    let releaseClipboard!: () => void
    let clipboardStarted!: () => void
    const started = new Promise<void>(resolve => {
      clipboardStarted = resolve
    })
    const clipboardGate = new Promise<void>(resolve => {
      releaseClipboard = resolve
    })
    const writeClipboard = vi.fn(async (value: string) => {
      expect(value).toBe('gfs://main/0123456789abcdef0123456789abcdef')
      order.push('clipboard-start')
      clipboardStarted()
      await clipboardGate
      order.push('clipboard-settled')
    })
    const generation = app.getSessionGeneration()
    const copying = service.copyGfsResourceId(
      'gfs://main/0123456789abcdef0123456789abcdef',
      writeClipboard,
      generation
    )
    await started
    const loggingOut = service.logout()
    releaseClipboard()

    await expect(copying).resolves.toEqual({
      resourceId: 'gfs://main/0123456789abcdef0123456789abcdef',
    })
    await loggingOut
    expect(order).toEqual(['clipboard-start', 'clipboard-settled', 'logout-commit'])
    await expect(
      service.copyGfsResourceId(
        'gfs://main/0123456789abcdef0123456789abcdef',
        writeClipboard,
        generation
      )
    ).rejects.toThrow()
    expect(writeClipboard).toHaveBeenCalledOnce()
  })

  it.each(['S144', 'S145'] as const)(
    '%s freezes the real save receipt before queued logout commits',
    async outcome => {
      const { service } = await createNativeCommitTestHarness()
      const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
      service.authClient = {
        googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me }),
      } as never
      await service.googleLogin('synthetic-google-token')

      const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
      const bytes = new TextEncoder().encode(`native-queue-${outcome}`).buffer
      const app = service as unknown as {
        gfsClient: { downloadWithReceipt: ReturnType<typeof vi.fn> }
        getSessionGeneration(): number
        tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }
      }
      app.gfsClient.downloadWithReceipt = vi.fn(async () => ({
        uri,
        version: 19,
        filename: 'queue.bin',
        bytes,
      }))
      const admission = await service.admitGfsSave(uri, app.getSessionGeneration())
      await admission.receipt

      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `r26-${outcome.toLowerCase()}-`))
      const filePath = path.join(directory, 'queue.bin')
      const readStarted = deferred<void>()
      const releaseRead = deferred<void>()
      const order: string[] = []
      const originalClear = app.tokenStore.clearSessionToken
      app.tokenStore.clearSessionToken = vi.fn(async (...args: unknown[]) => {
        order.push('logout-commit')
        await originalClear(...args)
      })
      const saving = saveGfsReceiptToPath({
        uri,
        version: 19,
        filePath,
        bytes,
        publishFence: finalize => service.publishGfsSave(admission.binding, finalize),
        readPublishedIdentity: async (_stage, attempt) => {
          readStarted.resolve()
          await releaseRead.promise
          if (outcome === 'S144' && attempt === 'primary') {
            throw new Error('injected primary read failure')
          }
          if (outcome === 'S145') throw new Error(`injected ${attempt} read failure`)
          const stat = await fs.stat(filePath)
          return `${stat.dev}:${stat.ino}`
        },
      })

      try {
        await readStarted.promise
        const finalBeforeRelease = await fs.readFile(filePath)
        expect(finalBeforeRelease.equals(Buffer.from(bytes))).toBe(true)
        expect(order).toEqual([])
        const logout = service.logout().then(value => {
          order.push('logout-resolved')
          return value
        })
        await Promise.resolve()
        expect(order).toEqual([])
        releaseRead.resolve()
        const receipt = await saving
        order.push('save-caller-resolved')
        await logout

        expect(order).toEqual(['save-caller-resolved', 'logout-commit', 'logout-resolved'])
        expect(receipt.status).toBe(
          outcome === 'S144' ? 'saved_access_verified' : 'published_access_unverified'
        )
        expect(await fs.readFile(filePath)).toEqual(Buffer.from(bytes))
        const frozen = JSON.stringify(receipt)
        await new Promise(resolve => setImmediate(resolve))
        expect(JSON.stringify(receipt)).toBe(frozen)
      } finally {
        releaseRead.resolve()
        await saving.catch(() => undefined)
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(['S144', 'S145'] as const)(
    '%s keeps the registered save IPC caller inside the real auth queue until receipt freeze',
    async outcome => {
      const { service, ipcHandlers, saveDialog } = await createNativeCommitTestHarness()
      service.authClient = {
        googleLogin: vi.fn().mockResolvedValue({
          token: 'synthetic-session-ipc',
          me: { id: 'user-ipc', email: 'user-ipc@example.test', teamId: 'team-a' },
        }),
      } as never
      await service.googleLogin('synthetic-google-token')

      const uri = 'gfs://main/1123456789abcdef0123456789abcdef'
      const bytes = new TextEncoder().encode(`ipc-native-queue-${outcome}`).buffer
      const app = service as unknown as {
        gfsClient: { downloadWithReceipt: ReturnType<typeof vi.fn> }
        tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }
        logout(): Promise<number>
      }
      app.gfsClient.downloadWithReceipt = vi.fn(async () => ({
        uri,
        version: 23,
        filename: 'ipc-queue.bin',
        bytes,
      }))

      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), `r26-ipc-${outcome.toLowerCase()}-`)
      )
      const filePath = path.join(directory, 'ipc-queue.bin')
      saveDialog.mockResolvedValue({ canceled: false, filePath })
      const readStarted = deferred<void>()
      const releaseRead = deferred<void>()
      const order: string[] = []
      const attempts: string[] = []
      const originalClear = app.tokenStore.clearSessionToken
      app.tokenStore.clearSessionToken = vi.fn(async (...args: unknown[]) => {
        order.push('logout-commit')
        await originalClear(...args)
      })
      const { registerIpcHandlers, setIpcGfsSaveReadbackTestHook } = await import('../ipc.js')
      setIpcGfsSaveReadbackTestHook(async (stage, attempt) => {
        attempts.push(attempt)
        if (attempt === 'primary') throw new Error('injected primary read failure')
        readStarted.resolve()
        await releaseRead.promise
        if (outcome === 'S145') throw new Error('injected inconclusive reconciliation')
        return stage.fileIdentity
      })

      try {
        registerIpcHandlers(service as never, async () => 0)
        const handler = ipcHandlers.get('gfs:saveToDisk') as
          | ((event: unknown, payload: unknown) => Promise<unknown>)
          | undefined
        expect(handler).toBeTypeOf('function')
        const caller = handler!(
          { senderFrame: { url: 'file:///app/index.html' }, sender: {} },
          {
            uri,
            expectedSessionGeneration: service.getSessionGeneration(),
            requestId: `r26-ipc-${outcome.toLowerCase()}`,
          }
        )

        await vi.waitFor(() => expect(saveDialog).toHaveBeenCalledOnce(), { timeout: 5000 })
        const firstSettlement = await Promise.race([
          readStarted.promise.then(() => 'reconciliation-started' as const),
          caller.then(
            () => 'caller-settled' as const,
            () => 'caller-rejected' as const
          ),
        ])
        expect(firstSettlement).toBe('reconciliation-started')
        expect((await fs.readFile(filePath)).equals(Buffer.from(bytes))).toBe(true)
        expect((await fs.readdir(directory)).some(name => name.endsWith('.partial'))).toBe(true)
        expect(order).toEqual([])
        const logout = service.logout().then(value => {
          order.push('logout-resolved')
          return value
        })
        await Promise.resolve()
        expect(order).toEqual([])

        releaseRead.resolve()
        const receipt = (await caller) as { status: string }
        order.push('save-caller-resolved')
        await logout
        expect(order).toEqual(['save-caller-resolved', 'logout-commit', 'logout-resolved'])
        expect(receipt.status).toBe(
          outcome === 'S144' ? 'saved_access_verified' : 'published_access_unverified'
        )
        expect(attempts).toEqual(['primary', 'reconciliation'])
        expect((await fs.readFile(filePath)).equals(Buffer.from(bytes))).toBe(true)
        expect((await fs.readdir(directory)).some(name => name.endsWith('.partial'))).toBe(
          outcome === 'S145'
        )
        const frozen = JSON.stringify(receipt)
        await new Promise(resolve => setImmediate(resolve))
        expect(JSON.stringify(receipt)).toBe(frozen)
      } finally {
        releaseRead.resolve()
        setIpcGfsSaveReadbackTestHook(undefined)
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('persists real version-2 GFS state as suspended_auth on logout', async () => {
    const { service } = await createNativeCommitTestHarness()
    const me = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me }),
    } as never
    await service.googleLogin('synthetic-google-token')
    const app = service as unknown as {
      gfsScopeIdentity: {
        ownerId: string
        teamId: string | null
        environmentKey: string
        baseUrl: string
      }
      gfsAuthEpoch: number
      persistDesktopGfsUpload(record: unknown): Promise<void>
      desktopGfsUploadStatePath(): Promise<string>
    }
    const identity = app.gfsScopeIdentity
    const uploadId = '92929292-9292-4292-8292-929292929292'
    await app.persistDesktopGfsUpload({
      version: 2,
      uploadId,
      filePath: '/tmp/payload.bin',
      fileName: 'payload.bin',
      fileSize: 4,
      target: { operation: 'create', parentRid: 'parent-a' },
      name: 'payload.bin',
      session: {
        uploadId,
        drive: 'main',
        operation: 'create',
        expectedBytes: 4,
        partBytes: 4,
        partCount: 1,
        state: 'uploading',
        contiguousBytes: 0,
        committedBytes: 0,
        committedPartCount: 0,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      scope: { ...identity, drive: 'main', authEpoch: app.gfsAuthEpoch },
      status: 'active',
      updatedAt: new Date().toISOString(),
    })

    await service.logout()

    const statePath = await app.desktopGfsUploadStatePath()
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      version: number
      records: Array<{ uploadId: string; status: string }>
    }
    expect(state.version).toBe(2)
    expect(state.records).toEqual([expect.objectContaining({ uploadId, status: 'suspended_auth' })])
  })

  it('rejects desktop setup while preserving the active authenticated environment', async () => {
    const { service, runtimeConfig, restA, restB } = await createNativeCommitTestHarness()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me }),
    } as never
    const setupRequest = vi.fn().mockResolvedValue({
      valid: true,
      email: 'user-a@example.test',
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: 'https://rpc-b.example.test',
      appName: 'Environment B',
    })
    const serviceInternals = service as unknown as {
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
      getSessionGeneration: () => number
    }
    serviceInternals.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }

    await service.googleLogin('synthetic-google-token')
    const runtimeBeforeSetup = runtimeConfig.getDesktopRuntimeConfigState()
    const generationBeforeSetup = serviceInternals.getSessionGeneration()
    const gfsScopeBeforeSetup = service.gfsScopeIdentity

    await expect(
      serviceInternals.completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
    ).rejects.toThrow('desktop_setup_requires_signout')

    expect(setupRequest).not.toHaveBeenCalled()
    expect(runtimeConfig.getDesktopRuntimeConfigState()).toEqual(runtimeBeforeSetup)
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)
    expect(service.sessionToken).toBe('synthetic-session-a')
    expect(service.getCachedUserId()).toBe('user-a')
    await expect(service.getSessionState()).resolves.toMatchObject({ authenticated: true, me })
    expect(serviceInternals.getSessionGeneration()).toBe(generationBeforeSetup)
    expect(service.gfsScopeIdentity).toEqual(gfsScopeBeforeSetup)
  })

  it('rejects desktop setup while an explicit login is in flight', async () => {
    const { service } = await createNativeCommitTestHarness()
    const loginStarted = deferred<void>()
    const loginResponse = deferred<{
      token: string
      me: { id: string; email: string; teamId: string }
    }>()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    service.authClient = {
      googleLogin: vi.fn(() => {
        loginStarted.resolve()
        return loginResponse.promise
      }),
    } as never
    const setupRequest = vi.fn().mockRejectedValue(new Error('unexpected setup dispatch'))
    const serviceInternals = service as unknown as {
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
    }
    serviceInternals.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }

    const login = service.googleLogin('synthetic-google-token')
    await loginStarted.promise
    const generationDuringLogin = service.getSessionGeneration()
    const setupOutcome = await serviceInternals
      .completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
      .then(
        () => ({ error: null as unknown }),
        error => ({ error })
      )
    const generationAfterSetup = service.getSessionGeneration()
    loginResponse.resolve({ token: 'synthetic-session-a', me })
    const loginOutcome = await login.then(
      result => ({ result, error: null as unknown }),
      error => ({ result: null, error })
    )

    expect(setupOutcome.error).toBeInstanceOf(Error)
    expect((setupOutcome.error as Error).message).toBe('auth_transition_in_progress')
    expect(setupRequest).not.toHaveBeenCalled()
    expect(generationAfterSetup).toBe(generationDuringLogin)
    expect(loginOutcome.error).toBeNull()
    expect(loginOutcome.result).toMatchObject({ authenticated: true, me })
    expect(service.getSessionGeneration()).toBe(generationDuringLogin + 1)
  })

  it('uses the captured generation when login wins before setup dispatch', async () => {
    const { service } = await createNativeCommitTestHarness()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me }),
    } as never
    const setupRequest = vi.fn().mockResolvedValue({
      valid: true,
      email: 'user-a@example.test',
      externalRestApiBaseUrl: 'https://api-b.example.test',
      rpcProxyBaseUrl: 'https://rpc-b.example.test',
      appName: 'Environment B',
    })
    const app = service as unknown as {
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
      withNativeAuthEnvironmentCommit<T>(operation: () => Promise<T>): Promise<T>
    }
    app.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }
    const originalCommit = app.withNativeAuthEnvironmentCommit.bind(service)
    let commitCount = 0
    app.withNativeAuthEnvironmentCommit = async operation => {
      commitCount += 1
      if (commitCount === 2) {
        app.withNativeAuthEnvironmentCommit = originalCommit
        await service.googleLogin('synthetic-login-before-setup-dispatch')
      }
      return originalCommit(operation)
    }

    await expect(
      app.completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
    ).rejects.toThrow('stale_session_generation')

    expect(setupRequest).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe('synthetic-session-a')
    expect(service.getCachedUserId()).toBe('user-a')
  })

  it('rejects handoff environment saves after auth changes or while auth is active', async () => {
    const { service, runtimeConfig, optionB, restA, restB } = await createNativeCommitTestHarness()
    const loginStarted = deferred<void>()
    const loginResponse = deferred<{
      token: string
      me: { id: string; email: string; teamId: string }
    }>()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    service.authClient = {
      googleLogin: vi.fn(() => {
        loginStarted.resolve()
        return loginResponse.promise
      }),
    } as never

    const nextConfig = {
      appName: 'Environment B',
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: 'https://rpc-b.example.test',
    }
    const saveRuntimeConfigForHandoff = service.saveRuntimeConfig.bind(service) as (
      config: Parameters<typeof service.saveRuntimeConfig>[0],
      expectedSessionGeneration: number
    ) => Promise<unknown>
    const expectedGeneration = service.getSessionGeneration()
    const login = service.googleLogin('synthetic-google-token')
    await loginStarted.promise
    const generationDuringLogin = service.getSessionGeneration()

    await expect(
      service.selectRuntimeConfigForHandoff(optionB.id, expectedGeneration)
    ).rejects.toThrow('stale_session_generation')
    await expect(
      service.selectRuntimeConfigForHandoff(optionB.id, generationDuringLogin)
    ).rejects.toThrow('auth_transition_in_progress')
    await expect(saveRuntimeConfigForHandoff(nextConfig, expectedGeneration)).rejects.toThrow(
      'stale_session_generation'
    )
    await expect(saveRuntimeConfigForHandoff(nextConfig, generationDuringLogin)).rejects.toThrow(
      'auth_transition_in_progress'
    )
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)

    loginResponse.resolve({ token: 'synthetic-session-a', me })
    await expect(login).resolves.toMatchObject({ authenticated: true, me })
    const authenticatedGeneration = service.getSessionGeneration()
    await expect(
      service.selectRuntimeConfigForHandoff(optionB.id, authenticatedGeneration)
    ).rejects.toThrow('desktop_setup_requires_signout')
    await expect(saveRuntimeConfigForHandoff(nextConfig, authenticatedGeneration)).rejects.toThrow(
      'desktop_setup_requires_signout'
    )
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me,
    })
  })

  it('keeps a pending environment selection ahead of a login commit', async () => {
    const { service, runtimeConfig, restA, restB, optionB } = await createNativeCommitTestHarness()
    const loginStarted = deferred<void>()
    const releaseLogin = deferred<void>()
    let handoffRequestRest = ''
    service.authClient = {
      googleLogin: vi.fn(async (token: string) => {
        const requestRest = runtimeConfig.config.externalRestApiBaseUrl
        if (token === 'handoff-login') {
          handoffRequestRest = requestRest
          loginStarted.resolve()
          await releaseLogin.promise
          return requestRest === restA
            ? { token: 'synthetic-session-a-next', me: { id: 'user-a' } }
            : { token: 'synthetic-session-b', me: { id: 'user-b' } }
        }
        return { token: 'synthetic-session-a', me: { id: 'user-a' } }
      }),
    } as never
    await service.googleLogin('initial-login')

    let handoffLogin: Promise<unknown> | null = null
    const selectReal = runtimeConfig.selectDesktopRuntimeConfigOption.bind(runtimeConfig)
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockImplementation(async id => {
      if (id === optionB.id) handoffLogin = service.googleLogin('handoff-login')
      await selectReal(id)
    })

    const selection = service.selectRuntimeConfig(optionB.id)
    const selectionOutcome = await selection.then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason })
    )
    await loginStarted.promise
    releaseLogin.resolve()
    const loginOutcome = await handoffLogin

    expect(selectionOutcome.status).toBe('fulfilled')
    expect(handoffRequestRest).toBe(restB)
    expect(loginOutcome).toMatchObject({ authenticated: true, me: { id: 'user-b' } })
    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me: { id: 'user-b' },
    })
    await expect(service.listGfsUploadSessions()).resolves.toEqual([])
    expect(service.gfsScopeIdentity).toMatchObject({
      ownerId: 'user-b',
      environmentKey: runtimeConfig.getDesktopRuntimeConfigState().envKey,
      baseUrl: restB,
    })
  })
})
