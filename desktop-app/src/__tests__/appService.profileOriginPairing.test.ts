import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import fs from 'node:fs/promises'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { desktopEnvironmentDiscoveryUrl } from '../desktopEnvironmentUrl.js'

afterEach(async () => {
  await cleanupNativeCommitTestHarness()
  vi.restoreAllMocks()
})

type LinkService = {
  me: { id: string; email: string } | null
  sessionToken: string | null
  selectRuntimeConfig: (id: string) => Promise<unknown>
  createSandboxUiDeepLink: () => Promise<{ url: string }>
  createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
  openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
  suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
  stopAllStreams: () => void
  ensureEntityChangeConnection: () => void
}

const appLocation = {
  recipeNs: 'sandbox-recipes',
  recipeName: 'task-board',
  path: '/tasks/42',
}
const gfsUri = 'gfs://main/0123456789abcdef0123456789abcdef'

async function useRealAppServiceLocation(service: LinkService): Promise<void> {
  const driver = await import('../sandboxUiDriver.js')
  vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue(appLocation)
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  service.ensureEntityChangeConnection = vi.fn()
}

async function persistActiveProfileOrigin(
  harness: Awaited<ReturnType<typeof createNativeCommitTestHarness>>,
  origin: string
): Promise<void> {
  const identity = harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()
  if (!identity) throw new Error('active profile identity is unavailable')
  await harness.runtimeConfig.persistProfileUiOrigin(identity, origin)
}

function authenticate(service: LinkService, suffix: string): void {
  service.sessionToken = `synthetic-session-${suffix}`
  service.me = { id: 'user-1', email: 'user@example.test' }
}

function expectedAppLink(profileOrigin: string): string {
  return `${profileOrigin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`
}

function expectedGfsLink(profileOrigin: string): string {
  return `${profileOrigin}/open/files?uri=${encodeURIComponent(gfsUri)}`
}

describe('AppService active Profile origin pairing', () => {
  it('matches the independent saved-origin model across real AppService actions', async () => {
    type Environment = 'A' | 'B'
    type Profile = { optionId: string; rest: string; origin: string | null }
    type Model = {
      selected: Environment
      profiles: Record<Environment, Profile>
      serverOrigins: Record<Environment, string>
      requests: Record<Environment, number>
      pending?: { environment: Environment; origin: string; selectionChanged: boolean }
    }
    type Real = {
      service: LinkService
      runtimeConfig: Awaited<ReturnType<typeof createNativeCommitTestHarness>>['runtimeConfig']
      options: Record<Environment, { id: string; configPath: string }>
      restByEnvironment: Record<Environment, string>
      serverOrigins: Record<Environment, string>
      requests: Record<Environment, number>
      scheduler: fc.Scheduler
      discovery: ReturnType<typeof vi.fn>
      shell: { openExternal: ReturnType<typeof vi.fn> }
      pending?: { environment: Environment; origin: string; action: Promise<unknown> }
    }

    class Select implements fc.AsyncCommand<Model, Real> {
      constructor(readonly environment: Environment) {}
      check(): boolean {
        return true
      }
      async run(model: Model, real: Real): Promise<void> {
        await real.service.selectRuntimeConfig(real.options[this.environment].id)
        model.selected = this.environment
        if (model.pending) model.pending.selectionChanged = true
        expect(real.runtimeConfig.getActiveRuntimeConfigOptionId()).toBe(
          real.options[this.environment].id
        )
      }
      toString(): string {
        return `select(${this.environment})`
      }
    }

    class ChangeServer implements fc.AsyncCommand<Model, Real> {
      constructor(
        readonly environment: Environment,
        readonly version: number
      ) {}
      check(): boolean {
        return true
      }
      async run(model: Model, real: Real): Promise<void> {
        const origin = `https://profile-${this.environment.toLowerCase()}-v${this.version}.example.test`
        model.serverOrigins[this.environment] = origin
        real.serverOrigins[this.environment] = origin
        const saved = model.profiles[this.environment].origin
        if (saved) expect(await readSavedOrigin(real, this.environment)).toBe(saved)
      }
      toString(): string {
        return `server-origin-change(${this.environment},${this.version})`
      }
    }

    class Open implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.pending === undefined
      }
      async run(model: Model, real: Real): Promise<void> {
        const environment = model.selected
        const profile = model.profiles[environment]
        const origin = profile.origin ?? model.serverOrigins[environment]
        const requestsBefore = real.discovery.mock.calls.length
        const action = real.service.openForgotPassword('user@example.test')
        const result = await real.scheduler.waitFor(action)
        expect(result.profileUiUrl).toBe(`${origin}/forgot-password?email=user%40example.test`)
        expect(real.shell.openExternal).toHaveBeenLastCalledWith(result.profileUiUrl)
        if (profile.origin === null) {
          model.profiles[environment].origin = origin
          model.requests[environment] += 1
          expect(real.discovery).toHaveBeenCalledTimes(requestsBefore + 1)
        } else {
          expect(real.discovery).toHaveBeenCalledTimes(requestsBefore)
        }
        expect(await readSavedOrigin(real, environment)).toBe(origin)
        expect(real.requests).toEqual(model.requests)
      }
      toString(): string {
        return 'open-forgot-password-through-AppService()'
      }
    }

    class StartPending implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.pending === undefined && model.profiles[model.selected].origin === null
      }
      async run(model: Model, real: Real): Promise<void> {
        const environment = model.selected
        const origin = model.serverOrigins[environment]
        const before = real.discovery.mock.calls.length
        const action = real.service.openForgotPassword('user@example.test')
        await vi.waitFor(() => expect(real.discovery).toHaveBeenCalledTimes(before + 1))
        real.pending = { environment, origin, action }
        model.pending = { environment, origin, selectionChanged: false }
      }
      toString(): string {
        return 'start-discovery(active-profile)'
      }
    }

    class CompletePending implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.pending !== undefined
      }
      async run(model: Model, real: Real): Promise<void> {
        const pending = real.pending
        const expected = model.pending
        if (!pending || !expected) throw new Error('pending discovery command lost its request')
        const opensBefore = real.shell.openExternal.mock.calls.length
        if (!expected.selectionChanged) {
          const result = (await real.scheduler.waitFor(pending.action)) as { profileUiUrl: string }
          expect(result.profileUiUrl).toBe(
            `${expected.origin}/forgot-password?email=user%40example.test`
          )
          expect(real.shell.openExternal).toHaveBeenLastCalledWith(result.profileUiUrl)
        } else {
          const expectedError =
            model.selected === expected.environment
              ? 'stale_session_generation'
              : 'stale_runtime_environment'
          await expect(real.scheduler.waitFor(pending.action)).rejects.toThrow(expectedError)
          expect(real.shell.openExternal).toHaveBeenCalledTimes(opensBefore)
        }
        // Persistence is profile-bound and may complete even when the action's
        // later session/environment authorization rejects browser dispatch.
        model.profiles[expected.environment].origin = expected.origin
        model.requests[expected.environment] += 1
        real.pending = undefined
        model.pending = undefined
        expect(await readSavedOrigin(real, expected.environment)).toBe(expected.origin)
        expect(real.requests).toEqual(model.requests)
      }
      toString(): string {
        return 'settle-real-discovery-and-persistence()'
      }
    }

    async function readSavedOrigin(real: Real, environment: Environment): Promise<string | null> {
      const contents = await fs.readFile(real.options[environment].configPath, 'utf8')
      const parsed = JSON.parse(contents) as { profileUiBaseUrl?: unknown }
      return typeof parsed.profileUiBaseUrl === 'string' ? parsed.profileUiBaseUrl : null
    }

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(
          [
            fc.constantFrom<Environment>('A', 'B').map(environment => new Select(environment)),
            fc
              .constantFrom<Environment>('A', 'B')
              .chain(environment =>
                fc
                  .integer({ min: 2, max: 9 })
                  .map(version => new ChangeServer(environment, version))
              ),
            fc.constant(new Open()),
            fc.constant(new StartPending()),
            fc.constant(new CompletePending()),
          ],
          { maxCommands: 14 }
        ),
        async (scheduler, commands) => {
          const restA = 'https://api.example.test/v1?tenant=a'
          const restB = 'https://api.example.test/v1?tenant=b'
          const harness = await createNativeCommitTestHarness({ restA, restB })
          const service = harness.service as LinkService & {
            authClient: { getDesktopEnvironmentForEndpoint: (endpoint: string) => Promise<unknown> }
          }
          const { shell } = await import('electron')
          const shellApi = shell as unknown as { openExternal: ReturnType<typeof vi.fn> }
          const restByEnvironment = { A: restA, B: restB }
          const serverOrigins = {
            A: 'https://profile-a-v1.example.test',
            B: 'https://profile-b-v1.example.test',
          }
          const requests = { A: 0, B: 0 }
          const options = {
            A: { id: harness.optionA.id, configPath: harness.optionA.configPath! },
            B: { id: harness.optionB.id, configPath: harness.optionB.configPath! },
          }
          const discovery = vi.fn((endpoint: string) => {
            const environment = endpoint === restA ? 'A' : endpoint === restB ? 'B' : null
            if (!environment) throw new Error(`unexpected discovery endpoint: ${endpoint}`)
            requests[environment] += 1
            const origin = serverOrigins[environment]
            const response = {
              externalRestApiBaseUrl: endpoint,
              responseUrl: desktopEnvironmentDiscoveryUrl(endpoint),
              rpcProxyBaseUrl: `https://rpc-${environment.toLowerCase()}.example.test`,
              appName: `Environment ${environment}`,
              profileUiBaseUrl: origin,
            }
            return scheduler.schedule(
              Promise.resolve(response),
              `discovery-${environment}-${requests[environment]}`
            )
          })
          service.authClient.getDesktopEnvironmentForEndpoint = discovery
          const model: Model = {
            selected: 'A',
            profiles: {
              A: { optionId: options.A.id, rest: restA, origin: null },
              B: { optionId: options.B.id, rest: restB, origin: null },
            },
            serverOrigins: { ...serverOrigins },
            requests: { A: 0, B: 0 },
          }
          const real: Real = {
            service,
            runtimeConfig: harness.runtimeConfig,
            options,
            restByEnvironment,
            serverOrigins,
            requests,
            scheduler,
            discovery,
            shell: shellApi,
          }
          try {
            await fc.asyncModelRun(() => ({ model, real }), commands)
            if (real.pending) {
              await new CompletePending().run(model, real)
            }
            await scheduler.waitAll()
            for (const environment of ['A', 'B'] as const) {
              expect(await readSavedOrigin(real, environment)).toBe(
                model.profiles[environment].origin
              )
            }
            expect(real.requests).toEqual(model.requests)
          } finally {
            await cleanupNativeCommitTestHarness()
          }
        }
      ),
      { numRuns: 20 }
    )
  })

  it('opens Forgot Password on built-in Localhost without discovery or profile persistence', async () => {
    const harness = await createNativeCommitTestHarness({
      configuredRest: 'https://api.saved.example.test',
      restA: 'https://api.saved.example.test',
    })
    const service = harness.service as LinkService
    await useRealAppServiceLocation(service)
    await service.selectRuntimeConfig('__localhost__')
    const state = harness.runtimeConfig.getDesktopRuntimeConfigState()
    const storagePath = state.storagePath
    const filesBefore = (await fs.readdir(storagePath)).sort()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { shell } = await import('electron')

    await expect(service.openForgotPassword('User@Example.test')).resolves.toMatchObject({
      profileUiUrl: 'http://127.0.0.1:3001/forgot-password?email=user%40example.test',
    })
    expect(shell.openExternal).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/forgot-password?email=user%40example.test'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await fs.readdir(storagePath)).sort()).toEqual(filesBefore)
    expect(harness.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(
      '__localhost__'
    )
    fetchSpy.mockRestore()
  })

  it('uses the exact-paired operator origin before a saved profile is selected', async () => {
    const rest = 'https://api.operator.example.test'
    const profile = 'https://profile.operator.example.test'
    const harness = await createNativeCommitTestHarness({
      configuredRest: rest,
      profileUiBaseUrl: profile,
      restA: rest,
    })
    const service = harness.service as LinkService
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const optionsBefore = harness.runtimeConfig.getDesktopRuntimeConfigState().options

    await harness.runtimeConfig.clearDesktopRuntimeConfigSelection()
    expect(harness.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBeNull()
    await expect(service.openForgotPassword('operator@example.test')).resolves.toMatchObject({
      profileUiUrl: `${profile}/forgot-password?email=operator%40example.test`,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(harness.runtimeConfig.getDesktopRuntimeConfigState().options).toEqual(optionsBefore)

    const { shell } = await import('electron')
    expect(shell.openExternal).toHaveBeenCalledWith(
      `${profile}/forgot-password?email=operator%40example.test`
    )
    fetchSpy.mockRestore()
  })

  it('does not persist an unsafe Profile origin returned by discovery', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    const identity = runtimeConfig.getActiveRuntimeConfigProfileIdentity()
    if (!identity) throw new Error('active profile identity is unavailable')
    const discovery = vi.fn().mockResolvedValue({
      externalRestApiBaseUrl: restA,
      responseUrl: new URL(`${restA}/api/v1/desktop/environment`).href,
      rpcProxyBaseUrl: 'https://rpc.customer.example.test',
      appName: 'Customer',
      profileUiBaseUrl: 'https://user:secret@profile.customer.example.test',
    })
    ;(
      service as unknown as { authClient: { getDesktopEnvironmentForEndpoint: typeof discovery } }
    ).authClient = { getDesktopEnvironmentForEndpoint: discovery }
    const { shell } = await import('electron')

    await expect(service.openForgotPassword('user@example.test')).rejects.toThrow()
    expect(discovery).toHaveBeenCalledOnce()
    expect(runtimeConfig.getActiveRuntimeConfigProfileIdentity()).not.toHaveProperty(
      'profileUiBaseUrl'
    )
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('does not persist an origin from a discovery response for another REST endpoint', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    const discovery = vi.fn().mockResolvedValue({
      externalRestApiBaseUrl: 'https://api.other-tenant.example.test',
      responseUrl: new URL(`${restA}/api/v1/desktop/environment`).href,
      rpcProxyBaseUrl: 'https://rpc.other-tenant.example.test',
      appName: 'Other tenant',
      profileUiBaseUrl: 'https://profile.other-tenant.example.test',
    })
    ;(
      service as unknown as { authClient: { getDesktopEnvironmentForEndpoint: typeof discovery } }
    ).authClient = { getDesktopEnvironmentForEndpoint: discovery }
    const { shell } = await import('electron')

    await expect(service.openForgotPassword('user@example.test')).rejects.toThrow(
      'desktop_environment_rest_endpoint_mismatch'
    )
    expect(discovery).toHaveBeenCalledWith(restA, expect.any(AbortSignal))
    expect(runtimeConfig.getActiveRuntimeConfigProfileIdentity()).not.toHaveProperty(
      'profileUiBaseUrl'
    )
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('uses real App and GFS producers through development-to-custom-production and reverse switches', async () => {
    const developmentRest = 'https://api.dev.example.test'
    const productionRest = 'https://customer-rest.example.test:9443/api?tenant=one'
    const productionProfile = 'https://profile.customer.example.test:9444'
    const harness = await createNativeCommitTestHarness({
      configuredRest: productionRest,
      profileUiBaseUrl: productionProfile,
      restA: developmentRest,
      restB: productionRest,
    })
    const service = harness.service as LinkService
    await useRealAppServiceLocation(service)

    await persistActiveProfileOrigin(harness, 'https://profile.dev.example.test')
    await service.selectRuntimeConfig(harness.optionB.id)
    await persistActiveProfileOrigin(harness, productionProfile)
    await service.selectRuntimeConfig(harness.optionA.id)

    expect(harness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(
      'https://profile.dev.example.test'
    )
    authenticate(service, 'development')
    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: expectedAppLink('https://profile.dev.example.test'),
    })
    await expect(service.createGfsResourceDeepLink(gfsUri)).resolves.toEqual({
      url: expectedGfsLink('https://profile.dev.example.test'),
    })

    await service.selectRuntimeConfig(harness.optionB.id)
    expect(harness.runtimeConfig.config.externalRestApiBaseUrl).toBe(productionRest)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    authenticate(service, 'production')
    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: expectedAppLink(productionProfile),
    })
    await expect(service.createGfsResourceDeepLink(gfsUri)).resolves.toEqual({
      url: expectedGfsLink(productionProfile),
    })

    await service.selectRuntimeConfig(harness.optionA.id)
    expect(harness.runtimeConfig.config.externalRestApiBaseUrl).toBe(developmentRest)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    authenticate(service, 'development-again')
    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: expectedAppLink('https://profile.dev.example.test'),
    })
    await expect(service.createGfsResourceDeepLink(gfsUri)).resolves.toEqual({
      url: expectedGfsLink('https://profile.dev.example.test'),
    })
  })

  it('preserves the paired loopback Profile scheme, host alias, and nondefault port', async () => {
    const harness = await createNativeCommitTestHarness({
      configuredRest: 'http://localhost:27191',
      profileUiBaseUrl: 'https://127.0.0.1:27101',
      restA: 'http://[::1]:27191',
      restB: 'https://api.prod.example.test',
    })
    const service = harness.service as LinkService
    await useRealAppServiceLocation(service)
    authenticate(service, 'loopback')

    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: expectedAppLink('https://127.0.0.1:27101'),
    })
    await expect(service.createGfsResourceDeepLink(gfsUri)).resolves.toEqual({
      url: expectedGfsLink('https://127.0.0.1:27101'),
    })

    const restIdentity = await import('../desktopEnvironmentUrl.js')
    expect(
      restIdentity.sameDesktopRestEndpoint('http://localhost:27191', 'http://[::1]:27191')
    ).toBe(false)
  })

  it.each([
    ['credentials', 'https://user:secret@profile.customer.example.test:9444'],
    ['a non-root path', 'https://profile.customer.example.test:9444/profile'],
    ['a query', 'https://profile.customer.example.test:9444?tenant=one'],
    ['a fragment', 'https://profile.customer.example.test:9444#profile'],
    ['an unsupported scheme', 'file:///tmp/profile'],
  ])(
    'rejects a matching custom REST pair with Profile origin containing %s',
    async (_label, profile) => {
      const productionRest = 'https://customer-rest.example.test:9443/api?tenant=one'
      const harness = await createNativeCommitTestHarness({
        configuredRest: productionRest,
        profileUiBaseUrl: profile,
        restA: productionRest,
        restB: 'https://api.dev.example.test',
      })
      const service = harness.service as LinkService
      await useRealAppServiceLocation(service)
      authenticate(service, 'invalid-origin')

      await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
        'operator_profile_ui_origin_invalid'
      )
      await expect(service.createGfsResourceDeepLink(gfsUri)).rejects.toThrow(
        'operator_profile_ui_origin_invalid'
      )
    }
  )

  it('fails closed for an unpaired custom active REST environment', async () => {
    const configuredRest = 'https://customer-rest.example.test:9443/api?tenant=one'
    const profileOrigin = 'https://profile.customer.example.test:9444'
    const activeRest = 'https://unpaired-rest.example.test:9443/api?tenant=one'
    const harness = await createNativeCommitTestHarness({
      configuredRest,
      profileUiBaseUrl: profileOrigin,
      restA: configuredRest,
      restB: activeRest,
    })
    const service = harness.service as LinkService
    await useRealAppServiceLocation(service)
    await service.selectRuntimeConfig(harness.optionB.id)
    authenticate(service, 'unpaired')

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow()
    await expect(service.createGfsResourceDeepLink(gfsUri)).rejects.toThrow()
  })
})
