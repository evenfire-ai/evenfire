import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult, testSessionMe } from '../../testSupport/authTestFixtures.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupNativeCommitTestHarness()
})

function discoveryResponseUrl(restBaseUrl: string): string {
  return new URL(`${restBaseUrl.replace(/\/+$/, '')}/api/v1/desktop/environment`).href
}

async function waitPastDiscoveryCooldown(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1_010))
}

type DesktopEnvironmentDiscovery = {
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
  appName: string
}

describe('AppService runtime config discovery ownership', () => {
  it('keeps Setup staging outside the native queue so selection can commit first', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const { MemberRegistrationServiceClient } =
      await import('../memberRegistrationServiceClient.js')
    vi.spyOn(MemberRegistrationServiceClient.prototype, 'completeDesktopSetup').mockResolvedValue({
      valid: true,
      email: 'user@example.test',
      externalRestApiBaseUrl: 'https://api-setup.example.test',
      rpcProxyBaseUrl: '',
      appName: 'Setup environment',
    } as never)

    const stage = deferred<void>()
    const stageStarted = deferred<void>()
    const originalWriteFile = fsp.writeFile.bind(fsp)
    const fsPromises = fsp as unknown as { writeFile: (...args: any[]) => Promise<void> }
    let heldStage = false
    const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockImplementation((...args: any[]) => {
      if (!heldStage && String(args[0]).includes('.runtime-config-stage-')) {
        heldStage = true
        stageStarted.resolve()
        return stage.promise.then(() =>
          originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
        )
      }
      return originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
    })

    try {
      const setup = service.completeDesktopSetup('user@example.test', 'setup-token')
      await stageStarted.promise

      const selection = service.selectRuntimeConfig(optionB.id)
      let selectionTimeout: ReturnType<typeof setTimeout> | undefined
      const selectionSettled = await Promise.race([
        selection.then(
          () => true,
          () => false
        ),
        new Promise<boolean>(resolve => {
          selectionTimeout = setTimeout(() => resolve(false), 500)
        }),
      ])
      if (selectionTimeout) clearTimeout(selectionTimeout)
      if (!selectionSettled) {
        stage.resolve()
        await selection.catch(() => undefined)
      }
      expect(selectionSettled).toBe(true)
      expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)

      stage.resolve()
      await expect(setup).rejects.toThrow('stale_session_generation')
      expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)
      expect(
        runtimeConfig
          .getDesktopRuntimeConfigState()
          .options.some(
            option => option.externalRestApiBaseUrl === 'https://api-setup.example.test'
          )
      ).toBe(false)
    } finally {
      stage.resolve()
      writeSpy.mockRestore()
    }
  })

  it('models a held real add stage while scheduled selection makes progress', async () => {
    class ModelBeginAdd implements fc.AsyncCommand<QueueModel, QueueSystem> {
      check(model: QueueModel): boolean {
        return model.phase === 'idle'
      }
      async run(model: QueueModel, real: QueueSystem): Promise<void> {
        real.addPromise = real.service.saveRuntimeConfig({
          externalRestApiBaseUrl: 'https://api-model-c.example.test',
          rpcProxyBaseUrl: 'https://rpc-model-c.example.test',
          appName: 'Model C',
        })
        void real.addPromise.catch(() => undefined)
        model.phase = 'staging'
        await real.stageStarted.promise
        expect(
          real.runtimeConfig
            .getDesktopRuntimeConfigState()
            .options.some(
              option => option.externalRestApiBaseUrl === 'https://api-model-c.example.test'
            )
        ).toBe(false)
        expect(real.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(
          model.selected
        )
      }
      toString(): string {
        return 'begin-add-with-real-filesystem-stage()'
      }
    }

    class ModelSelectB implements fc.AsyncCommand<QueueModel, QueueSystem> {
      check(model: QueueModel): boolean {
        return model.phase === 'staging'
      }
      async run(model: QueueModel, real: QueueSystem): Promise<void> {
        const selection = real.scheduler.schedule(
          real.service.selectRuntimeConfig(real.optionB.id),
          'select-B-while-stage-is-held'
        )
        await real.scheduler.waitFor(selection)
        model.selected = real.optionB.id
        model.phase = 'selected'
        expect(real.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(
          model.selected
        )
      }
      toString(): string {
        return 'schedule-selection-while-real-stage-is-held()'
      }
    }

    class ModelResolveAdd implements fc.AsyncCommand<QueueModel, QueueSystem> {
      check(model: QueueModel): boolean {
        return model.phase === 'selected'
      }
      async run(model: QueueModel, real: QueueSystem): Promise<void> {
        real.stage.resolve()
        await expect(real.addPromise).rejects.toThrow('stale_session_generation')
        model.phase = 'resolved'
        expect(real.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(
          model.selected
        )
        expect(
          real.runtimeConfig
            .getDesktopRuntimeConfigState()
            .options.some(
              option => option.externalRestApiBaseUrl === 'https://api-model-c.example.test'
            )
        ).toBe(false)
      }
      toString(): string {
        return 'resolve-stale-add-after-selection-commit()'
      }
    }

    type QueueModel = { phase: 'idle' | 'staging' | 'selected' | 'resolved'; selected: string }
    type QueueSystem = {
      service: {
        saveRuntimeConfig: (next: {
          externalRestApiBaseUrl: string
          rpcProxyBaseUrl: string
          appName: string
        }) => Promise<unknown>
        selectRuntimeConfig: (optionId: string) => Promise<unknown>
      }
      runtimeConfig: Awaited<
        ReturnType<
          (typeof import('../../testSupport/appService.nativeCommitTestHarness.js'))['createNativeCommitTestHarness']
        >
      >['runtimeConfig']
      optionB: { id: string }
      stage: ReturnType<typeof deferred<void>>
      stageStarted: ReturnType<typeof deferred<void>>
      addPromise: Promise<unknown>
      scheduler: fc.Scheduler
    }

    await fc.assert(
      fc.asyncProperty(
        fc.commands(
          [
            fc.constant(null).map(() => new ModelBeginAdd()),
            fc.constant(null).map(() => new ModelSelectB()),
            fc.constant(null).map(() => new ModelResolveAdd()),
          ],
          { maxCommands: 4 }
        ),
        fc.scheduler(),
        async (commands, scheduler) => {
          const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
          const stage = deferred<void>()
          const stageStarted = deferred<void>()
          const originalWriteFile = fsp.writeFile.bind(fsp)
          const fsPromises = fsp as unknown as { writeFile: (...args: any[]) => Promise<void> }
          let heldStage = false
          const writeSpy = vi
            .spyOn(fsPromises, 'writeFile')
            .mockImplementation((...args: any[]) => {
              if (!heldStage && String(args[0]).includes('.runtime-config-stage-')) {
                heldStage = true
                stageStarted.resolve()
                return stage.promise.then(() =>
                  originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
                )
              }
              return originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
            })
          const model: QueueModel = {
            phase: 'idle',
            selected: runtimeConfig.getDesktopRuntimeConfigState().activeOptionId || '',
          }
          const real: QueueSystem = {
            service: service as QueueSystem['service'],
            runtimeConfig,
            optionB,
            stage,
            stageStarted,
            addPromise: Promise.resolve(),
            scheduler,
          }
          ;(service as unknown as { authClient: unknown }).authClient = {
            getDesktopEnvironmentForEndpoint: vi.fn().mockRejectedValue(new Error('offline')),
          }
          try {
            await fc.asyncModelRun(() => ({ model, real }), commands)
            if (model.phase === 'staging') {
              await new ModelSelectB().run(model, real)
              await new ModelResolveAdd().run(model, real)
            } else if (model.phase === 'selected') {
              await new ModelResolveAdd().run(model, real)
            }
            expect(model.phase === 'idle' || model.phase === 'resolved').toBe(true)
            expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(model.selected)
            await scheduler.waitAll()
          } finally {
            stage.resolve()
            writeSpy.mockRestore()
          }
        }
      ),
      { numRuns: 20 }
    )
  })

  it('stages on disk before queue admission and lets selection progress during a held stage', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const staging = deferred<void>()
    const stagingStarted = deferred<void>()
    const originalWriteFile = fsp.writeFile.bind(fsp)
    const fsPromises = fsp as unknown as { writeFile: (...args: any[]) => Promise<void> }
    let sawStage = false
    vi.spyOn(fsPromises, 'writeFile').mockImplementation((...args: any[]) => {
      const stagePath = String(args[0])
      if (stagePath.includes('.runtime-config-stage-') && !sawStage) {
        sawStage = true
        stagingStarted.resolve()
        return staging.promise.then(() =>
          originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
        )
      }
      return originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
    })
    const app = service as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      saveRuntimeConfig: (next: {
        externalRestApiBaseUrl: string
        rpcProxyBaseUrl: string
        appName: string
      }) => Promise<unknown>
      selectRuntimeConfig: (optionId: string) => Promise<unknown>
    }
    app.authClient = {
      getDesktopEnvironmentForEndpoint: vi.fn().mockRejectedValue(new Error('offline')),
    }

    const add = app.saveRuntimeConfig({
      externalRestApiBaseUrl: 'https://api-c.example.test',
      rpcProxyBaseUrl: 'https://rpc-c.example.test',
      appName: 'Environment C',
    })
    const stagedBeforeAdmission = await Promise.race([
      stagingStarted.promise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ])
    if (!stagedBeforeAdmission) {
      staging.resolve()
      await add.catch(() => undefined)
    }
    expect(stagedBeforeAdmission).toBe(true)
    await expect(app.selectRuntimeConfig(optionB.id)).resolves.toBeDefined()
    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)

    staging.resolve()
    await expect(add).rejects.toThrow('stale_session_generation')
    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)
  })

  it('shares one discovery through RPC and Profile origin persistence staging', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const stage = deferred<void>()
    const stageStarted = deferred<void>()
    const originalWriteFile = fsp.writeFile.bind(fsp)
    const fsPromises = fsp as unknown as { writeFile: (...args: any[]) => Promise<void> }
    let held = false
    const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockImplementation((...args: any[]) => {
      const stagePath = String(args[0])
      if (!held && stagePath.includes('.runtime-config-stage-')) {
        held = true
        stageStarted.resolve()
        return stage.promise.then(() =>
          originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
        )
      }
      return originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
    })
    const profileOrigin = 'https://profile-discovered.example.test'
    const getDesktopEnvironmentForEndpoint = vi.fn().mockResolvedValue({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      profileUiBaseUrl: profileOrigin,
      appName: 'Environment A',
      responseUrl: discoveryResponseUrl(restA),
    })
    const app = service as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
      resolveProfileUiBaseUrl: () => Promise<string>
    }
    app.authClient = { getDesktopEnvironmentForEndpoint }

    try {
      const rpcResolution = app.resolveRuntimeConfigIfNeeded()
      await stageStarted.promise
      const profileResolution = app.resolveProfileUiBaseUrl()

      expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledOnce()
      stage.resolve()
      await expect(Promise.all([rpcResolution, profileResolution])).resolves.toEqual([
        undefined,
        profileOrigin,
      ])
      expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
      expect(runtimeConfig.getActiveRuntimeConfigProfileIdentity()).toMatchObject({
        profileUiBaseUrl: profileOrigin,
      })
    } finally {
      stage.resolve()
      writeSpy.mockRestore()
    }
  })

  it('lets selection commit while a new profile stage is unresolved, then rejects the stale add', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const staging = deferred<void>()
    const stagingStarted = deferred<void>()
    const stageNormally = runtimeConfig.stagePreparedDesktopRuntimeConfigMutation
    const stage = vi.spyOn(runtimeConfig, 'stagePreparedDesktopRuntimeConfigMutation')
    stage.mockImplementation(async ticket => {
      if (ticket.created) {
        stagingStarted.resolve()
        await staging.promise
      }
      await stageNormally(ticket)
    })
    const app = service as unknown as {
      saveRuntimeConfig: (next: {
        externalRestApiBaseUrl: string
        rpcProxyBaseUrl: string
        appName: string
      }) => Promise<unknown>
      selectRuntimeConfig: (optionId: string) => Promise<unknown>
    }

    const add = app.saveRuntimeConfig({
      externalRestApiBaseUrl: 'https://api-c.example.test',
      rpcProxyBaseUrl: 'https://rpc-c.example.test',
      appName: 'Environment C',
    })
    await stagingStarted.promise

    await expect(app.selectRuntimeConfig(optionB.id)).resolves.toBeDefined()
    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)

    staging.resolve()
    await expect(add).rejects.toThrow('stale_session_generation')
    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)
    expect(
      runtimeConfig
        .getDesktopRuntimeConfigState()
        .options.some(option => option.externalRestApiBaseUrl === 'https://api-c.example.test')
    ).toBe(false)
  })

  it('does not roll back an inactive-profile deletion when an older add stage is rejected', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const staging = deferred<void>()
    const stagingStarted = deferred<void>()
    const stageNormally = runtimeConfig.stagePreparedDesktopRuntimeConfigMutation
    vi.spyOn(runtimeConfig, 'stagePreparedDesktopRuntimeConfigMutation').mockImplementation(
      async ticket => {
        if (ticket.created) {
          stagingStarted.resolve()
          await staging.promise
        }
        await stageNormally(ticket)
      }
    )
    const app = service as unknown as {
      saveRuntimeConfig: (next: {
        externalRestApiBaseUrl: string
        rpcProxyBaseUrl: string
        appName: string
      }) => Promise<unknown>
      deleteRuntimeConfig: (optionId: string) => Promise<unknown>
    }

    const add = app.saveRuntimeConfig({
      externalRestApiBaseUrl: 'https://api-c.example.test',
      rpcProxyBaseUrl: 'https://rpc-c.example.test',
      appName: 'Environment C',
    })
    await stagingStarted.promise
    await app.deleteRuntimeConfig(optionB.id)
    expect(
      runtimeConfig.getDesktopRuntimeConfigState().options.some(option => option.id === optionB.id)
    ).toBe(false)

    staging.resolve()
    const addError = await add.then(
      () => null,
      error => (error instanceof Error ? error.message : String(error))
    )
    const finalState = runtimeConfig.getDesktopRuntimeConfigState()
    expect(finalState.activeOptionId).not.toBe(optionB.id)
    expect(finalState.options.some(option => option.id === optionB.id)).toBe(false)
    expect(
      finalState.options.some(
        option => option.externalRestApiBaseUrl === 'https://api-c.example.test'
      )
    ).toBe(false)
    expect(addError).toBe('stale_runtime_config_index')
  })

  it('rejects a fully staged config commit after shutdown closes admission', async () => {
    const { service, runtimeConfig } = await createNativeCommitTestHarness()
    const shutdownService = service as unknown as {
      beginShutdown: () => void
    }
    const ticket = runtimeConfig.prepareDesktopRuntimeConfigSave({
      externalRestApiBaseUrl: 'https://api-after-shutdown.example.test',
      rpcProxyBaseUrl: 'https://rpc-after-shutdown.example.test',
      appName: 'After shutdown',
    })
    await runtimeConfig.stagePreparedDesktopRuntimeConfigMutation(ticket)
    const indexPath = path.join(
      runtimeConfig.getDesktopRuntimeConfigState().storagePath,
      'index.json'
    )
    const indexBefore = await fsp.readFile(indexPath)

    shutdownService.beginShutdown()

    await expect(runtimeConfig.commitPreparedDesktopRuntimeConfigMutation(ticket)).rejects.toThrow(
      'desktop_shutting_down'
    )
    expect(await fsp.readFile(indexPath)).toEqual(indexBefore)
  })

  it('uses RPC discovery completed before the signed-out login result is installed', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const me = testSessionMe()
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn>
        googleLogin: ReturnType<typeof vi.fn>
      }
    }
    app.authClient = {
      getDesktopEnvironmentForEndpoint: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: restA,
        responseUrl: discoveryResponseUrl(restA),
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      }),
      googleLogin: vi.fn().mockResolvedValue(testLoginResult('session-token-a', me)),
    }

    await service.googleLogin('google-token-a')

    const rpcEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
    expect(rpcEnvKey).not.toBe(restOnlyEnvKey)
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledWith('session-token-a', rpcEnvKey)
    expect(bindChatStoreForUser).toHaveBeenLastCalledWith(
      me.id,
      rpcEnvKey,
      expect.objectContaining({ legacyEnvKeys: [restOnlyEnvKey] })
    )
  })

  it('uses late RPC discovery for the active session without rebinding its durable identity', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const me = testSessionMe()
    const getDesktopEnvironmentForEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary discovery failure'))
      .mockResolvedValue({
        externalRestApiBaseUrl: restA,
        responseUrl: discoveryResponseUrl(restA),
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      })
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironmentForEndpoint: typeof getDesktopEnvironmentForEndpoint
        googleLogin: ReturnType<typeof vi.fn>
        health: ReturnType<typeof vi.fn>
      }
      rpcClient: { health: ReturnType<typeof vi.fn> }
      getEffectiveRpcProxyBaseUrl: () => string
      getDependenciesHealth: () => Promise<unknown>
      getChatDeletionFenceAuthority: () => {
        authorityScope: { environmentKey: string }
        sessionGeneration: number
      }
      openDesktop: (hostRef: string) => Promise<void>
      gfsScopeIdentity: { environmentKey: string } | null
    }
    app.authClient = {
      getDesktopEnvironmentForEndpoint,
      googleLogin: vi
        .fn()
        .mockResolvedValueOnce(testLoginResult('session-token-a', me))
        .mockResolvedValueOnce(testLoginResult('session-token-b', me)),
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    const { AuthClient } = await import('../authClient.js')
    vi.spyOn(AuthClient.prototype, 'issueRpcToken').mockResolvedValue({
      token: 'fixture-rpc-token',
      accessScope: 'team',
      teamId: 'team-a',
      scopes: ['desktop:view'],
      hostRefs: ['chatllm'],
      expiresInSeconds: 60,
    })
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }

    await service.googleLogin('google-token-a')
    await waitPastDiscoveryCooldown()
    const generation = service.getSessionGeneration()
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
    const activeBindingCount = vi.mocked(bindChatStoreForUser).mock.calls.length
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledWith(
      'session-token-a',
      restOnlyEnvKey
    )

    await app.getDependenciesHealth()
    await app.getDependenciesHealth()
    await app.getDependenciesHealth()

    expect(runtimeConfig.getDesktopRuntimeConfigState().envKey).toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
    expect(app.getEffectiveRpcProxyBaseUrl()).toBe('https://rpc-discovered.example.test')
    expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledTimes(2)
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bindChatStoreForUser)).toHaveBeenCalledTimes(activeBindingCount)
    expect(app.getChatDeletionFenceAuthority().authorityScope.environmentKey).toBe(restOnlyEnvKey)
    expect(service.getSessionGeneration()).toBe(generation)
    expect(service.getCachedUserId()).toBe('user-a')
    expect(app.gfsScopeIdentity?.environmentKey).toBe(restOnlyEnvKey)

    const openDesktopWindow = vi.fn().mockResolvedValue(undefined)
    vi.doMock('../desktopWindow.js', () => ({ openDesktopWindow }))
    await app.openDesktop('chatllm')
    expect(openDesktopWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        hostRef: 'chatllm',
        rpcProxyUrl: 'https://rpc-discovered.example.test',
      })
    )

    await service.logout()

    const rpcConfiguredEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    expect(rpcConfiguredEnvKey).not.toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(service.tokenStore.clearSessionToken).toHaveBeenCalledWith(
      restOnlyEnvKey,
      expect.any(Object)
    )
    expect(app.gfsScopeIdentity).toBeNull()

    await service.googleLogin('google-token-b')
    expect(service.tokenStore.setSessionToken).toHaveBeenLastCalledWith(
      'session-token-b',
      rpcConfiguredEnvKey
    )
    expect(bindChatStoreForUser).toHaveBeenLastCalledWith(
      'user-a',
      rpcConfiguredEnvKey,
      expect.objectContaining({ legacyEnvKeys: [restOnlyEnvKey] })
    )
  })

  it('uses discovery completed during saved-session restore without changing durable identity', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const discovery = deferred<DesktopEnvironmentDiscovery>()
    const discoveryStarted = deferred<void>()
    const restoredMe = deferred<ReturnType<typeof testSessionMe>>()
    const getDesktopEnvironmentForEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new Error('startup discovery unavailable'))
      .mockImplementationOnce(() => {
        discoveryStarted.resolve()
        return discovery.promise
      })
      .mockRejectedValueOnce(new Error('later discovery must not be needed'))
    const getMeStarted = deferred<void>()
    const getMe = vi.fn(() => {
      getMeStarted.resolve()
      return restoredMe.promise
    })
    const me = testSessionMe()
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironmentForEndpoint: typeof getDesktopEnvironmentForEndpoint
        getMe: typeof getMe
        health: ReturnType<typeof vi.fn>
      }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
      getEffectiveRpcProxyBaseUrl: () => string
      getDependenciesHealth: () => Promise<unknown>
      rpcClient: { health: ReturnType<typeof vi.fn> }
      gfsScopeIdentity: { environmentKey: string } | null
    }
    app.authClient = {
      getDesktopEnvironmentForEndpoint,
      getMe,
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }
    service.tokenStore.getSessionToken.mockResolvedValue('synthetic-saved-session-a')
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')

    const restore = service.getSessionState()
    await getMeStarted.promise
    await waitPastDiscoveryCooldown()
    const discoveryRequest = app.resolveRuntimeConfigIfNeeded()
    await discoveryStarted.promise
    discovery.resolve({
      externalRestApiBaseUrl: restA,
      responseUrl: discoveryResponseUrl(restA),
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    })
    await discoveryRequest

    expect(runtimeConfig.getDesktopRuntimeConfigState().envKey).toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')

    restoredMe.resolve(me)
    await expect(restore).resolves.toMatchObject({ authenticated: true, me })
    expect(service.tokenStore.getSessionToken).toHaveBeenCalledWith(restOnlyEnvKey, {
      legacyEnvKeys: [],
    })
    expect(service.tokenStore.setSessionToken).not.toHaveBeenCalled()
    expect(bindChatStoreForUser).toHaveBeenLastCalledWith(
      'user-a',
      restOnlyEnvKey,
      expect.objectContaining({ legacyEnvKeys: [] })
    )
    expect(app.gfsScopeIdentity?.environmentKey).toBe(restOnlyEnvKey)
    expect(service.getCachedUserId()).toBe('user-a')
    expect(app.getEffectiveRpcProxyBaseUrl()).toBe('https://rpc-discovered.example.test')

    await expect(app.getDependenciesHealth()).resolves.toMatchObject({
      externalRestApi: { ok: true },
      rpcProxy: { ok: true },
    })
    expect(app.rpcClient.health).toHaveBeenCalledOnce()
    expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledTimes(2)

    await service.logout()
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(app.gfsScopeIdentity).toBeNull()
  })

  it('commits a restore-pending discovery before an interactive login captures its binding', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn>
        googleLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
        health: ReturnType<typeof vi.fn>
      }
      getDependenciesHealth: () => Promise<unknown>
    }
    const restoredMe = deferred<ReturnType<typeof testSessionMe>>()
    const restoreStarted = deferred<void>()
    const { RpcProxyClient } = await import('../rpcProxyClient.js')
    vi.spyOn(RpcProxyClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
    service.tokenStore.getSessionToken.mockResolvedValue('synthetic-saved-session')
    app.authClient = {
      getDesktopEnvironmentForEndpoint: vi
        .fn()
        .mockRejectedValueOnce(new Error('initial discovery unavailable'))
        .mockResolvedValue({
          externalRestApiBaseUrl: restA,
          responseUrl: discoveryResponseUrl(restA),
          rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
          appName: 'Environment A',
        }),
      googleLogin: vi.fn().mockResolvedValue(testLoginResult('session-token-a', testSessionMe())),
      getMe: vi.fn(() => {
        restoreStarted.resolve()
        return restoredMe.promise
      }),
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }

    const restore = service.getSessionState()
    await restoreStarted.promise
    await waitPastDiscoveryCooldown()
    await app.getDependenciesHealth()
    await service.googleLogin('google-token-a')
    restoredMe.resolve(testSessionMe())
    await restore

    const rpcAwareEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    expect(rpcAwareEnvKey).not.toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledWith(
      'session-token-a',
      rpcAwareEnvKey
    )
  })

  it('discards a stale effective endpoint when a different REST-only profile is selected', async () => {
    const { service, runtimeConfig, restA, restB } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: '',
      appName: 'Environment B',
    })
    const optionA = runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(option => option.externalRestApiBaseUrl === restA)
    const optionB = runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(option => option.externalRestApiBaseUrl === restB)
    if (!optionA || !optionB) throw new Error('test runtime profiles were not created')
    await runtimeConfig.selectDesktopRuntimeConfigOption(optionA.id)
    const app = service as unknown as {
      effectiveRuntimeRpcEndpoint:
        | (DesktopEnvironmentDiscovery & { profileId: string | null })
        | null
      pendingRuntimeConfigDiscovery:
        | (DesktopEnvironmentDiscovery & { profileId: string | null })
        | null
      getEffectiveRpcProxyBaseUrl: () => string
    }
    const { AuthClient } = await import('../authClient.js')
    vi.spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockRejectedValueOnce(new Error('initial discovery unavailable'))
      .mockResolvedValue({
        externalRestApiBaseUrl: restA,
        responseUrl: discoveryResponseUrl(restA),
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'A',
      })
    vi.spyOn(AuthClient.prototype, 'googleLogin').mockResolvedValue(testLoginResult())
    vi.spyOn(AuthClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
    const { RpcProxyClient } = await import('../rpcProxyClient.js')
    vi.spyOn(RpcProxyClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
    await service.googleLogin('synthetic-google')
    const { AppService } = await import('../appService.js')
    await (service as unknown as InstanceType<typeof AppService>).getDependenciesHealth()

    await service.selectRuntimeConfig(optionB.id)

    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restB)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
    expect(app.getEffectiveRpcProxyBaseUrl()).toBe('')
    expect(app.effectiveRuntimeRpcEndpoint).toBeNull()
    expect(app.pendingRuntimeConfigDiscovery).toBeNull()
  })

  it.each([
    [
      'Google',
      (service: { googleLogin: (idToken: string) => Promise<unknown> }) =>
        service.googleLogin('token'),
    ],
    [
      'password',
      (service: { passwordLogin: (email: string, password: string) => Promise<unknown> }) =>
        service.passwordLogin('user@example.test', 'password'),
    ],
  ])('commits matching discovery after a failed %s login', async (_kind, login) => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn>
        googleLogin: ReturnType<typeof vi.fn>
        passwordLogin: ReturnType<typeof vi.fn>
      }
      passwordLogin: (email: string, password: string) => Promise<unknown>
    }
    app.authClient = {
      getDesktopEnvironmentForEndpoint: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: restA,
        responseUrl: discoveryResponseUrl(restA),
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      }),
      googleLogin: vi.fn().mockRejectedValue(new Error('Google login rejected')),
      passwordLogin: vi.fn().mockRejectedValue(new Error('password login rejected')),
    }

    await expect(login(app)).rejects.toThrow('login rejected')

    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(service.tokenStore.setSessionToken).not.toHaveBeenCalled()
  })

  it('shares a pending discovery for the same profile and REST endpoint', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })

    const discovery = deferred<DesktopEnvironmentDiscovery>()
    const discoveryStarted = deferred<void>()
    const getDesktopEnvironmentForEndpoint = vi.fn(() => {
      discoveryStarted.resolve()
      return discovery.promise
    })
    const app = service as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
    }
    app.authClient = { getDesktopEnvironmentForEndpoint }

    const first = app.resolveRuntimeConfigIfNeeded()
    await discoveryStarted.promise
    const second = app.resolveRuntimeConfigIfNeeded()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledOnce()

    discovery.resolve({
      externalRestApiBaseUrl: restA,
      responseUrl: discoveryResponseUrl(restA),
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    })
    await Promise.all([first, second])

    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
  })

  it('starts a fresh RPC discovery after custom-file is deleted and recreated', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(
      runtimeConfig.getDesktopRuntimeConfigState().storagePath,
      'custom-runtime-config.json'
    )
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const oldIdentity = runtimeConfig.getActiveRuntimeConfigProfileIdentity()
    if (!oldIdentity || oldIdentity.profileId !== 'custom-file') {
      throw new Error('explicit runtime config identity was not established')
    }

    const oldDiscovery = deferred<
      DesktopEnvironmentDiscovery & {
        profileUiBaseUrl: string
        responseUrl: string
      }
    >()
    const newDiscovery = deferred<
      DesktopEnvironmentDiscovery & {
        profileUiBaseUrl: string
        responseUrl: string
      }
    >()
    const getDesktopEnvironmentForEndpoint = vi
      .fn()
      .mockReturnValueOnce(oldDiscovery.promise)
      .mockReturnValueOnce(newDiscovery.promise)
    const app = service as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
    }
    app.authClient = { getDesktopEnvironmentForEndpoint }

    const firstResolution = app.resolveRuntimeConfigIfNeeded()
    await vi.waitFor(() => expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledOnce())
    await runtimeConfig.deleteDesktopRuntimeConfigOption('custom-file')
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A recreated',
    })
    const newIdentity = runtimeConfig.getActiveRuntimeConfigProfileIdentity()
    if (!newIdentity || newIdentity.profileId !== 'custom-file') {
      throw new Error('recreated explicit runtime config identity was not established')
    }
    expect(newIdentity.incarnation).not.toBe(oldIdentity.incarnation)

    const secondResolution = app.resolveRuntimeConfigIfNeeded()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledTimes(2)
    newDiscovery.resolve({
      externalRestApiBaseUrl: restA,
      responseUrl: discoveryResponseUrl(restA),
      rpcProxyBaseUrl: 'https://rpc-new.example.test',
      profileUiBaseUrl: 'https://profile-new.example.test',
      appName: 'Environment A recreated',
    })
    await secondResolution
    oldDiscovery.resolve({
      externalRestApiBaseUrl: restA,
      responseUrl: discoveryResponseUrl(restA),
      rpcProxyBaseUrl: 'https://rpc-old.example.test',
      profileUiBaseUrl: 'https://profile-old.example.test',
      appName: 'Environment A',
    })
    await expect(firstResolution).rejects.toThrow('stale_runtime_profile')

    expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledTimes(2)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-new.example.test')
    expect(runtimeConfig.getActiveRuntimeConfigProfileIdentity()).toMatchObject({
      profileId: 'custom-file',
      profileUiBaseUrl: 'https://profile-new.example.test',
    })
  })

  it('shares one producer response between RPC projection and Profile origin persistence', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const identity = runtimeConfig.getActiveRuntimeConfigProfileIdentity()
    if (!identity) throw new Error('saved environment identity is unavailable')

    const discovery = deferred<
      DesktopEnvironmentDiscovery & {
        profileUiBaseUrl: string
        responseUrl: string
      }
    >()
    const getDesktopEnvironmentForEndpoint = vi.fn(() => discovery.promise)
    const app = service as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
      resolveProfileUiBaseUrl: () => Promise<string>
    }
    app.authClient = { getDesktopEnvironmentForEndpoint }

    const rpcResolution = app.resolveRuntimeConfigIfNeeded()
    const profileResolution = app.resolveProfileUiBaseUrl()
    await vi.waitFor(() => expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledOnce()
    discovery.resolve({
      externalRestApiBaseUrl: restA,
      responseUrl: discoveryResponseUrl(restA),
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      profileUiBaseUrl: 'https://profile-discovered.example.test',
      appName: 'Environment A',
    })

    await Promise.all([rpcResolution, profileResolution])
    expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledOnce()
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(runtimeConfig.getActiveRuntimeConfigProfileIdentity()).toMatchObject({
      profileId: identity.profileId,
      profileUiBaseUrl: 'https://profile-discovered.example.test',
    })
    expect(await app.resolveProfileUiBaseUrl()).toBe('https://profile-discovered.example.test')
  })

  it('clears a rejected discovery entry so the next call can retry', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })

    const getDesktopEnvironmentForEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary discovery failure'))
      .mockResolvedValue({
        externalRestApiBaseUrl: restA,
        responseUrl: discoveryResponseUrl(restA),
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      })
    const app = service as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
    }
    app.authClient = { getDesktopEnvironmentForEndpoint }

    await expect(app.resolveRuntimeConfigIfNeeded()).rejects.toThrow('temporary discovery failure')

    await expect(app.resolveRuntimeConfigIfNeeded()).rejects.toThrow('profile_ui_retry_cooldown')
    await waitPastDiscoveryCooldown()

    await expect(app.resolveRuntimeConfigIfNeeded()).resolves.toBeUndefined()

    expect(getDesktopEnvironmentForEndpoint).toHaveBeenCalledTimes(2)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
  })
})
