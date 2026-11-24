import { afterEach, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {
  type Deferred,
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

type Harness = Awaited<ReturnType<typeof createNativeCommitTestHarness>>
type AppServiceUnderTest = Harness['service'] & {
  sessionGeneration: number
  openForgotPassword(email: string): Promise<{ profileUiUrl: string }>
  openProfileSettings(
    email: string,
    options?: { section?: string; network?: string }
  ): Promise<{ profileUiUrl: string }>
  resolveRuntimeConfigIfNeeded(): Promise<void>
  saveRuntimeConfig(value: {
    externalRestApiBaseUrl: string
    rpcProxyBaseUrl: string
    appName: string
    profileUiBaseUrl?: string
  }): Promise<unknown>
  selectRuntimeConfig(optionId: string): Promise<unknown>
  deleteRuntimeConfig(optionId: string): Promise<unknown>
  logout(): Promise<number>
  suspendDesktopGfsUploadsForAuthBoundary(): Promise<void>
  withNativeAuthEnvironmentCommit<T>(operation: () => Promise<T>): Promise<T>
}

type DispatchModel = {
  phase: 'ready' | 'pending' | 'dispatched' | 'rejected'
  selected: 'A' | 'B'
  sessionCurrent: boolean
  witnessCurrent: boolean
  dispatchedOrigins: string[]
}

type DispatchReal = {
  harness: Harness
  service: AppServiceUnderTest
  scheduler?: fc.Scheduler
  electronImportStarted: Deferred<void>
  releaseElectronImport: Deferred<void>
  shellOpenExternal: ReturnType<typeof vi.fn>
  events: string[]
  dispatchSessionGenerations: number[]
  action?: Promise<{ profileUiUrl: string }>
}

const originA = 'https://10.0.0.5'
const originB = 'https://10.0.0.6'
const producerEnvironmentNames = [
  'NODE_ENV',
  'CLERUM_DEV_MODE',
  'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL',
  'EXTERNAL_REST_API_CORS_ORIGIN',
  'EXTERNAL_REST_API_GOOGLE_CLIENT_ID',
  'EXTERNAL_REST_API_CONTROL_API_BASE_URL',
  'EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN',
  'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
  'EXTERNAL_REST_API_JWT_ISSUER',
  'EXTERNAL_REST_API_JWT_AUDIENCE',
  'EXTERNAL_REST_API_PUBLIC_BASE_URL',
  'EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL',
] as const

function deferredValue<T = void>(): Deferred<T> {
  return deferred<T>()
}

async function createRealDispatchFixture(scheduler?: fc.Scheduler): Promise<DispatchReal> {
  const harness = await createNativeCommitTestHarness()
  const service = harness.service as AppServiceUnderTest
  service.resolveRuntimeConfigIfNeeded = vi.fn().mockResolvedValue(undefined)
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  const initialBinding = harness.runtimeConfig.captureProfileOriginBinding()
  await harness.runtimeConfig.persistProfileOriginForBinding(initialBinding, originA)
  const electronImportStarted = deferredValue<void>()
  const releaseElectronImport = deferredValue<void>()
  const events: string[] = []
  const dispatchSessionGenerations: number[] = []
  const shellOpenExternal = vi.fn(async (url: string) => {
    events.push(`dispatch:${url}`)
    dispatchSessionGenerations.push(service.sessionGeneration)
  })

  // The first Electron mock initializes the real config and AppService modules.
  // Reset only the loader cache afterward so the real dynamic import boundary can
  // be held while the already-created AppService instance remains under test.
  vi.doMock('electron', async () => {
    electronImportStarted.resolve(undefined)
    await releaseElectronImport.promise
    return {
      app: {
        getPath: () => '/synthetic-user-data',
        isPackaged: false,
        isReady: () => true,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal: shellOpenExternal },
    }
  })
  vi.resetModules()

  return {
    harness,
    service,
    ...(scheduler ? { scheduler } : {}),
    electronImportStarted,
    releaseElectronImport,
    shellOpenExternal,
    events,
    dispatchSessionGenerations,
  }
}

async function waitForElectronImport(real: DispatchReal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Electron import boundary did not start')), 3000)
  })
  try {
    await Promise.race([real.electronImportStarted.promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function settleAction(real: DispatchReal): Promise<{ profileUiUrl: string } | Error> {
  if (!real.action) throw new Error('dispatch model started without an action')
  const settled = real.action.then(
    value => value,
    error => error as Error
  )
  return real.scheduler ? real.scheduler.waitFor(real.scheduler.schedule(settled)) : settled
}

class QueueSelectionBeforeFinalAdmission implements fc.AsyncCommand<DispatchModel, DispatchReal> {
  check(model: Readonly<DispatchModel>): boolean {
    return model.phase === 'pending'
  }

  async run(model: DispatchModel, real: DispatchReal): Promise<void> {
    if (!real.scheduler) throw new Error('dispatch model requires the fast-check scheduler')
    let selectionCommitted = false
    const selection = real.service.selectRuntimeConfig(real.harness.optionB.id).then(() => {
      selectionCommitted = true
      model.selected = 'B'
      real.events.push('selection:B')
    })
    void selection.catch(() => undefined)
    await selection
    expect(selectionCommitted).toBe(true)
    expect(
      real.harness.runtimeConfig.getDesktopRuntimeConfigState().currentConfig.externalRestApiBaseUrl
    ).toBe(real.harness.restB)
    real.releaseElectronImport.resolve(undefined)
    const outcome = await settleAction(real)
    expect(outcome).toBeInstanceOf(Error)
    expect(real.shellOpenExternal).not.toHaveBeenCalled()
    expect(real.events).toEqual(['selection:B'])
    model.phase = 'rejected'
    model.selected = 'B'
    model.sessionCurrent = true
  }

  toString(): string {
    return 'commit-selection-before-final-admission-then-release-import'
  }
}

const commands = fc.commands([fc.constant(new QueueSelectionBeforeFinalAdmission())], {
  maxCommands: 1,
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  await cleanupNativeCommitTestHarness()
})

it('rejects when selection commits before final dispatch admission', async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), commands, async (scheduler, generatedCommands) => {
      const real = await createRealDispatchFixture(scheduler)
      const model: DispatchModel = {
        phase: 'ready',
        selected: 'A',
        sessionCurrent: true,
        witnessCurrent: true,
        dispatchedOrigins: [],
      }
      try {
        real.action = real.service.openForgotPassword('user@example.test')
        void real.action.catch(() => undefined)
        model.phase = 'pending'
        await waitForElectronImport(real)
        await fc.asyncModelRun(() => ({ model, real }), generatedCommands)
      } finally {
        real.releaseElectronImport.resolve(undefined)
        if (real.action) await Promise.allSettled([real.action])
        await cleanupNativeCommitTestHarness()
      }
    }),
    { seed: 146360, numRuns: 24, endOnFailure: true }
  )
})

it('uses the selected External REST producer private HTTPS origin in the Desktop destination', async () => {
  const savedEnvironment = Object.fromEntries(
    producerEnvironmentNames.map(name => [name, process.env[name]])
  )
  const server = http.createServer()
  let harness: Harness | undefined
  try {
    const key = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).publicKey
    Object.assign(process.env, {
      NODE_ENV: 'production',
      EXTERNAL_REST_API_CORS_ORIGIN: originA,
      EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: key,
      EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
      EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
      EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: 'https://rpc.example.test',
      CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: originA,
    })
    delete process.env.CLERUM_DEV_MODE
    const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
      'express'
    )
    const app = express()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('producer server has no TCP port')
    const rest = `http://127.0.0.1:${address.port}`
    process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL = rest
    const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
    app.use('/api/v1', createDesktopRouter())
    server.on('request', app)

    harness = await createNativeCommitTestHarness({ restA: rest })
    const response = await fetch(`${rest}/api/v1/desktop/environment`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      externalRestApiBaseUrl: rest,
      profileUiBaseUrl: originA,
    })
    const expectedProfileUiUrl = `${originA}/forgot-password?email=user%40example.test`
    const action = await harness.service.openForgotPassword('user@example.test').then(
      result => ({ status: 'resolved' as const, result }),
      error => ({ status: 'rejected' as const, error })
    )
    const electron = await import('electron')
    const openExternal = (
      electron as unknown as {
        shell: { openExternal: ReturnType<typeof vi.fn> }
      }
    ).shell.openExternal
    expect(openExternal).toHaveBeenCalledWith(expectedProfileUiUrl)
    expect(action).toEqual({ status: 'resolved', result: { profileUiUrl: expectedProfileUiUrl } })
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (harness) await cleanupNativeCommitTestHarness()
  }
})

it.each(['selected environment', 'session'] as const)(
  'rejects an old URL when a %s change commits before dispatch admission',
  async change => {
    const real = await createRealDispatchFixture()
    try {
      if (change === 'session') {
        real.service.sessionToken = 'synthetic-session'
        real.service.me = { id: 'user-1' } as never
      }
      real.action = real.service.openForgotPassword('user@example.test')
      void real.action.catch(() => undefined)
      if (change === 'selected environment') {
        await real.service.selectRuntimeConfig(real.harness.optionB.id)
        real.events.push('selection:B')
      } else {
        await real.service.logout()
        real.events.push('session:logout')
      }
      real.releaseElectronImport.resolve(undefined)
      const outcome = await settleAction(real)
      expect(real.shellOpenExternal).not.toHaveBeenCalled()
      expect(outcome).toBeInstanceOf(Error)
      expect(real.events).toEqual([
        change === 'selected environment' ? 'selection:B' : 'session:logout',
      ])
    } finally {
      real.releaseElectronImport.resolve(undefined)
      if (real.action) await Promise.allSettled([real.action])
      await cleanupNativeCommitTestHarness()
    }
  }
)

it('serializes dispatch-first before a queued logout', async () => {
  const real = await createRealDispatchFixture()
  const initialSessionGeneration = real.service.sessionGeneration
  const browserLaunch = deferred<void>()
  try {
    real.service.sessionToken = 'synthetic-session'
    real.service.me = { id: 'user-1' } as never
    real.action = real.service.openForgotPassword('user@example.test')
    void real.action.catch(() => undefined)
    await waitForElectronImport(real)
    real.shellOpenExternal.mockImplementationOnce(async url => {
      real.events.push(`dispatch:${url}`)
      real.dispatchSessionGenerations.push(real.service.sessionGeneration)
      await browserLaunch.promise
    })
    real.releaseElectronImport.resolve(undefined)
    await vi.waitFor(() => expect(real.shellOpenExternal).toHaveBeenCalledTimes(1))
    const logout = real.service.logout().then(() => real.events.push('session:logout'))
    const logoutSettled = await Promise.race([
      logout.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 750)),
    ])
    expect(logoutSettled).toBe(true)
    expect(real.events).toEqual([
      `dispatch:${originA}/forgot-password?email=user%40example.test`,
      'session:logout',
    ])
    expect(real.dispatchSessionGenerations).toEqual([initialSessionGeneration])
    browserLaunch.resolve(undefined)
    const outcome = await settleAction(real)
    expect(outcome).toEqual({
      profileUiUrl: `${originA}/forgot-password?email=user%40example.test`,
    })
    expect(real.shellOpenExternal).toHaveBeenCalledWith(
      `${originA}/forgot-password?email=user%40example.test`
    )
  } finally {
    browserLaunch.resolve(undefined)
    real.releaseElectronImport.resolve(undefined)
    if (real.action) await Promise.allSettled([real.action])
    await cleanupNativeCommitTestHarness()
  }
})

it('preserves the browser launch rejection for the caller', async () => {
  const real = await createRealDispatchFixture()
  try {
    real.shellOpenExternal.mockRejectedValueOnce(new Error('browser launch failed'))
    real.action = real.service.openForgotPassword('user@example.test')
    await waitForElectronImport(real)
    real.releaseElectronImport.resolve(undefined)
    await expect(real.action).rejects.toThrow('browser launch failed')
  } finally {
    real.releaseElectronImport.resolve(undefined)
    if (real.action) await Promise.allSettled([real.action])
    await cleanupNativeCommitTestHarness()
  }
})

it('rejects a stale Profile Settings social URL after selection commits before dispatch', async () => {
  const real = await createRealDispatchFixture()
  try {
    real.action = real.service.openProfileSettings('user@example.test', {
      section: 'social',
      network: 'github',
    })
    void real.action.catch(() => undefined)
    await real.service.selectRuntimeConfig(real.harness.optionB.id)
    real.events.push('selection:B')

    real.releaseElectronImport.resolve(undefined)
    const outcome = await settleAction(real)
    expect(real.shellOpenExternal).not.toHaveBeenCalled()
    expect(outcome).toBeInstanceOf(Error)
    expect(real.events).toEqual(['selection:B'])
  } finally {
    real.releaseElectronImport.resolve(undefined)
    if (real.action) await Promise.allSettled([real.action])
    await cleanupNativeCommitTestHarness()
  }
})

it('rejects a captured origin after same-ID/path/REST/RPC record deletion and recreation', async () => {
  const real = await createRealDispatchFixture()
  const originalFile = real.harness.optionA.configPath
  try {
    process.env.CLERUM_DESKTOP_CONFIG_PATH = originalFile
    await real.service.saveRuntimeConfig({
      externalRestApiBaseUrl: real.harness.restA,
      rpcProxyBaseUrl: 'https://rpc-a.example.test',
      appName: 'Environment A',
    })
    const before = real.harness.runtimeConfig.captureProfileOriginBinding()
    expect(before.profileId).toBe('custom-file')
    await real.harness.runtimeConfig.persistProfileOriginForBinding(before, originA)
    const sessionGeneration = real.service.sessionGeneration
    real.action = real.service.openForgotPassword('user@example.test')
    void real.action.catch(() => undefined)
    const deletion = real.service.withNativeAuthEnvironmentCommit(() =>
      real.harness.runtimeConfig.deleteDesktopRuntimeConfigOption('custom-file')
    )
    const recreation = real.service.withNativeAuthEnvironmentCommit(() =>
      real.harness.runtimeConfig.saveDesktopRuntimeConfig({
        externalRestApiBaseUrl: real.harness.restA,
        rpcProxyBaseUrl: 'https://rpc-a.example.test',
        appName: 'Environment A recreated',
      })
    )
    const persistReplacementOrigin = real.service.withNativeAuthEnvironmentCommit(async () => {
      const current = real.harness.runtimeConfig.captureProfileOriginBinding()
      await real.harness.runtimeConfig.persistProfileOriginForBinding(current, originB)
    })
    await Promise.all([deletion, recreation, persistReplacementOrigin])
    const replacement = real.harness.runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(option => option.id === 'custom-file')
    const current = real.harness.runtimeConfig.captureProfileOriginBinding()
    expect(replacement?.configPath).toBe(originalFile)
    expect(replacement?.externalRestApiBaseUrl).toBe(real.harness.restA)
    expect(replacement?.rpcProxyBaseUrl).toBe('https://rpc-a.example.test')
    expect(current.witness).not.toBe(before.witness)
    expect(real.service.sessionGeneration).toBe(sessionGeneration)
    expect(JSON.parse(await fs.readFile(originalFile!, 'utf8')).profileUiBaseUrl).toBe(originB)

    real.releaseElectronImport.resolve(undefined)
    const outcome = await settleAction(real)
    expect(real.shellOpenExternal).not.toHaveBeenCalled()
    expect(outcome).toBeInstanceOf(Error)
    expect(JSON.parse(await fs.readFile(originalFile!, 'utf8')).profileUiBaseUrl).toBe(originB)
  } finally {
    real.releaseElectronImport.resolve(undefined)
    if (real.action) await Promise.allSettled([real.action])
    await cleanupNativeCommitTestHarness()
  }
})

it('keeps the saved-record witness valid across a same-record save before dispatch', async () => {
  const real = await createRealDispatchFixture()
  const before = real.harness.runtimeConfig.captureProfileOriginBinding()
  try {
    real.action = real.service.openForgotPassword('user@example.test')
    void real.action.catch(() => undefined)
    await real.service.saveRuntimeConfig({
      externalRestApiBaseUrl: real.harness.restA,
      rpcProxyBaseUrl: 'https://rpc-a.example.test',
      appName: 'Environment A renamed',
      profileUiBaseUrl: originA,
    })
    const current = real.harness.runtimeConfig.captureProfileOriginBinding()
    expect(current.witness).toBe(before.witness)

    real.releaseElectronImport.resolve(undefined)
    const outcome = await settleAction(real)
    expect(outcome).toEqual({
      profileUiUrl: `${originA}/forgot-password?email=user%40example.test`,
    })
    expect(real.shellOpenExternal).toHaveBeenCalledTimes(1)
    expect(real.shellOpenExternal).toHaveBeenCalledWith(
      `${originA}/forgot-password?email=user%40example.test`
    )
  } finally {
    real.releaseElectronImport.resolve(undefined)
    if (real.action) await Promise.allSettled([real.action])
    await cleanupNativeCommitTestHarness()
  }
})
