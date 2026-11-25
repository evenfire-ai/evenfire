import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { format } from 'node:util'
import {
  type BrowserSignInHarness,
  FakeBrowserSignInClock,
  cleanupBrowserSignInHarness,
  createBrowserSignInHarness,
  harnessDriverUsers,
} from '../../testSupport/browserSignInHarness.js'
import { BROWSER_SIGN_IN_DEADLINE_MS, BrowserSignInAttempts } from '../browserSignIn.js'

// Bodies outside the feature contract (G-5) come from the harness. The discovery answer is the
// shape of the edge's own route, `external-rest-api/src/routes/desktop.ts:11-17`, with
// `externalRestApiBaseUrl` set to the profile's canonical endpoint.

afterEach(cleanupBrowserSignInHarness)

const UNTIL_TURN_LIMIT = 200

/** Drains until `reached`. The owner queue is not awaited: the point may be a hold under it. */
async function until(harness: BrowserSignInHarness, reached: () => boolean, what: string) {
  for (let turn = 0; !reached(); turn += 1) {
    if (turn >= UNTIL_TURN_LIMIT) throw new Error(`${what} was not reached`)
    await harness.drain({ owner: false })
  }
}

/** The values from `from` up to `to`, both included. */
function consecutive(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function fetchCount(harness: BrowserSignInHarness, method: string, path: string): number {
  return harness.fetches.filter(
    record => record.value.method === method && new URL(record.value.url).pathname === path
  ).length
}

/**
 * Runs `body`, then cleans the harness up. When `body` fails, its error is the one thrown, so
 * fast-check shrinks and reports the run's own failure; a cleanup failure after it is logged
 * beside it rather than put in its place.
 */
async function cleanUpAfter(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    await cleanupBrowserSignInHarness().catch((cleanupError: unknown) => {
      console.warn('T0-1: the harness cleanup also failed after a failed run:', cleanupError)
    })
    throw error
  }
  await cleanupBrowserSignInHarness()
}

// T0-1's reference model. Its state is what decides, per state model §2.1's Bump column,
// whether an event reaches a §2.2 site.
type EnvName = 'A' | 'B' | 'C' | 'D'
type BumpModel = {
  /** The selected environment; null after a clear (E24). */
  active: EnvName | null
  /** B can be deleted (E28). A holds the kept token and C is E27's fallback, so both stay. */
  bExists: boolean
  /** D is the REST-only environment that E26, E29 and the hub's setup answer (E32) save. */
  dExists: boolean
  signedIn: boolean
  /** A session token is saved under A's key, the only environment a kept token starts on. */
  storedA: boolean
}
type RuntimeConfigModule = typeof import('../config.js')
type BumpReal = {
  harness: BrowserSignInHarness
  scheduler: fc.Scheduler
  /** The `config.js` the harness's service loaded, read after `vi.resetModules()`. */
  runtimeConfig: RuntimeConfigModule
}
type Expectation = { bump: boolean; rejects?: string }
type Outcome = { ok: true } | { ok: false; message: string }
/** What a command saw before it ran, for the checks that compare before and after. */
type BeforeCommand = Readonly<{ optionCount: number; discoveryFetches: number; signedIn: boolean }>
type BumpEvent = {
  id: string
  label: string
  check(model: BumpModel): boolean
  expect(model: BumpModel): Expectation
  act(real: BumpReal, model: Readonly<BumpModel>): Promise<unknown>
  /** Moves the model; it runs once the real outcome matched the expectation. */
  next(model: BumpModel): void
  /** Checks the real service after the command, beyond the generation and the environment. */
  verify?(real: BumpReal, before: BeforeCommand): void
}

const ENV_D_REST = 'https://api-d.example.test'
const HUB_SETUP_ROUTE = 'POST /api/v1/invitations-flow/desktop-setup/complete'
const DISCOVERY_PATH = '/api/v1/desktop/environment'
// What the harness's discovery route answers for `rpcProxyBaseUrl` (as T0-5 reads it).
const DISCOVERED_RPC_BASE_URL = 'https://rpc-discovered.example.test'
const REFUSED_SIGNED_IN = 'desktop_setup_requires_signout'
const CONDITIONAL_EVENTS = ['E15', 'E16', 'E23', 'E29', 'E31/E32']
const bumpOutcomesSeen = new Map<string, Set<boolean>>()
/** E30 runs that committed a discovery while signed out (the path E30 exists to cover). */
let discoveryCommitsSeen = 0

function optionId(real: BumpReal, env: EnvName): string {
  if (env !== 'D') return real.harness.envs[env].optionId
  const option = real.harness.service
    .getRuntimeConfigState()
    .options.find(candidate => candidate.externalRestApiBaseUrl === ENV_D_REST)
  if (!option) throw new Error('environment D has no profile')
  return option.id
}

function exists(model: BumpModel, env: EnvName): boolean {
  if (env === 'B') return model.bExists
  if (env === 'D') return model.dExists
  return true
}

/** The stored profiles' REST URLs, as the model has them. */
function modelRestUrls(real: BumpReal, model: BumpModel): string[] {
  const envs: EnvName[] = ['A', 'C']
  if (model.bExists) envs.push('B')
  if (model.dExists) envs.push('D')
  return envs.map(env => (env === 'D' ? ENV_D_REST : real.harness.envs[env].restBaseUrl)).sort()
}

/** A boundary change away from A clears A's saved token (`appService.ts:2265`). */
function leave(model: BumpModel, next: EnvName | null) {
  if (model.active === 'A' && next !== 'A') model.storedA = false
  model.active = next
  model.signedIn = false
}

function signIn(model: BumpModel) {
  model.signedIn = true
  if (model.active === 'A') model.storedA = true
}

const saveD = (real: BumpReal, generation?: number) =>
  real.harness.service.saveRuntimeConfig(
    { externalRestApiBaseUrl: ENV_D_REST, rpcProxyBaseUrl: '', appName: 'Environment D' },
    generation
  )

const signedOutOnly = (model: BumpModel): Expectation =>
  model.signedIn ? { bump: false, rejects: REFUSED_SIGNED_IN } : { bump: true }

const bumpEvents = {
  passwordLogin: {
    id: 'E13',
    label: 'E13 password login',
    check: () => true,
    expect: model =>
      model.active === null ? { bump: true, rejects: 'desktop_setup_required' } : { bump: true },
    act: real => real.harness.service.passwordLogin('user-b@example.test', 'fake-password'),
    next: model => {
      if (model.active !== null) signIn(model)
    },
  },
  googleLogin: {
    id: 'E14',
    label: 'E14 Google login',
    check: model => model.active !== null,
    expect: () => ({ bump: true }),
    act: real => real.harness.service.googleLogin('fake-google-id-token'),
    next: signIn,
  },
  restore: {
    id: 'E15',
    label: 'E15 session restore (getSessionState)',
    check: () => true,
    // The model leaves out `getSessionState`'s 5 s retry gate (`appService.ts:3735-3740`): it
    // never decides an expectation here. `storedA` holds while signed out on A only before the
    // first restore on A (a kept token at start), and that restore succeeds. Every later
    // `storedA` comes from a sign-in on A, and every way back to signed out (logout, or a change
    // away from A) clears it.
    expect: model => ({ bump: !model.signedIn && model.active === 'A' && model.storedA }),
    act: real => real.harness.service.getSessionState(),
    next: model => {
      if (!model.signedIn && model.active === 'A' && model.storedA) model.signedIn = true
    },
  },
  switchTeam: {
    id: 'E16',
    label: 'E16 deliberate team switch',
    check: () => true,
    expect: model =>
      model.signedIn ? { bump: true } : { bump: false, rejects: 'Not authenticated' },
    act: real => real.harness.service.switchTeam('team-switched'),
    next: () => undefined,
  },
  reselectActive: {
    id: 'E22',
    label: 'E22 re-select the active environment',
    check: model => model.active !== null,
    expect: () => ({ bump: true }),
    act: (real, model) => {
      if (model.active === null) throw new Error('E22 has no active environment')
      return real.harness.service.selectRuntimeConfig(optionId(real, model.active))
    },
    next: () => undefined,
  },
  clear: {
    id: 'E24',
    label: 'E24 clear the selection',
    check: () => true,
    expect: () => ({ bump: true }),
    act: real => real.harness.service.clearRuntimeConfigSelection(),
    next: model => leave(model, null),
  },
  saveSame: {
    id: 'E25',
    label: 'E25 save the active environment again',
    check: model => model.active !== null,
    expect: () => ({ bump: false }),
    act: real => {
      const current = real.harness.service.getRuntimeConfigState().currentConfig
      if (!current) throw new Error('E25 found no active configuration')
      return real.harness.service.saveRuntimeConfig({ ...current })
    },
    next: () => undefined,
  },
  saveOther: {
    id: 'E26',
    label: 'E26 save environment D (another boundary)',
    check: model => model.active !== 'D',
    expect: () => ({ bump: true }),
    act: real => saveD(real),
    next: model => {
      leave(model, 'D')
      model.dExists = true
    },
  },
  deleteActive: {
    id: 'E27',
    label: 'E27 delete the active environment D',
    check: model => model.active === 'D',
    expect: () => ({ bump: true }),
    act: real => real.harness.service.deleteRuntimeConfig(optionId(real, 'D')),
    // The last stored profile becomes active (`config.ts` `resolveActiveProfile`): C, since D
    // is always stored after it.
    next: model => {
      leave(model, 'C')
      model.dExists = false
    },
  },
  handoffSave: {
    id: 'E29',
    label: 'E29 desktop-environment handoff saves environment D',
    check: model => model.active !== 'D',
    expect: signedOutOnly,
    act: real => saveD(real, real.harness.service.getSessionGeneration()),
    next: model => {
      if (model.signedIn) return
      leave(model, 'D')
      model.dExists = true
    },
  },
  discovery: {
    id: 'E30',
    label: 'E30 discovery commit (getDependenciesHealth)',
    check: model => model.active !== null,
    expect: () => ({ bump: false }),
    act: real => real.harness.service.getDependenciesHealth(),
    next: () => undefined,
    // A discovery fetch while signed out commits the RPC URL to the active profile
    // (`applyRuntimeConfigDiscovery`); signed in, it only sets the effective endpoint.
    verify: (real, before) => {
      const fetched = fetchCount(real.harness, 'GET', DISCOVERY_PATH) > before.discoveryFetches
      if (!fetched || before.signedIn) return
      expect(real.harness.service.getRuntimeConfigState().currentConfig?.rpcProxyBaseUrl).toBe(
        DISCOVERED_RPC_BASE_URL
      )
      discoveryCommitsSeen += 1
    },
  },
  desktopSetup: {
    id: 'E31/E32',
    label: 'E31/E32 desktop setup (the hub answers environment D)',
    check: () => true,
    expect: signedOutOnly,
    act: real =>
      real.harness.service.completeDesktopSetup(
        'user-d@example.test',
        'fake-setup-authorization-token'
      ),
    // Setup saves the hub's environment without clearing the previous key's token.
    next: model => {
      if (model.signedIn) return
      model.active = 'D'
      model.dExists = true
    },
  },
} satisfies Record<string, BumpEvent>

function logoutEvent(id: 'E19' | 'E20'): BumpEvent {
  return {
    id,
    // `evenfire://logout` reaches the same `AppService.logout()` through `main.ts:110-113`.
    label: id === 'E19' ? 'E19 auth:logout' : 'E20 evenfire://logout',
    check: () => true,
    expect: () => ({ bump: true }),
    act: real => real.harness.service.logout(),
    next: model => {
      if (model.active === 'A') model.storedA = false
      model.signedIn = false
    },
  }
}

function selectEvent(target: EnvName): BumpEvent {
  return {
    id: 'E21',
    label: `E21 select environment ${target}`,
    check: model => exists(model, target) && model.active !== target,
    expect: () => ({ bump: true }),
    act: real => real.harness.service.selectRuntimeConfig(optionId(real, target)),
    next: model => leave(model, target),
  }
}

function deleteOtherEvent(target: 'B' | 'D'): BumpEvent {
  return {
    id: 'E28',
    label: `E28 delete environment ${target} while another is active`,
    check: model => exists(model, target) && model.active !== target,
    expect: () => ({ bump: false }),
    act: real => real.harness.service.deleteRuntimeConfig(optionId(real, target)),
    next: model => {
      if (target === 'B') model.bExists = false
      else model.dExists = false
    },
    verify: (real, before) => {
      expect(real.harness.service.getRuntimeConfigState().options).toHaveLength(
        before.optionCount - 1
      )
    },
  }
}

function handoffSelectEvent(target: EnvName): BumpEvent {
  return {
    id: 'E23',
    label: `E23 handoff selects environment ${target}`,
    check: model => exists(model, target),
    expect: signedOutOnly,
    act: real =>
      real.harness.service.selectRuntimeConfigForHandoff(
        optionId(real, target),
        real.harness.service.getSessionGeneration()
      ),
    next: model => {
      if (model.signedIn || model.active === target) return
      leave(model, target)
    },
  }
}

async function settle(real: BumpReal, act: () => Promise<unknown>): Promise<Outcome> {
  const settled: Promise<Outcome> = Promise.resolve()
    .then(act)
    .then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      })
    )
  const outcome = await real.scheduler.waitFor(settled)
  await real.harness.drain()
  return outcome
}

class BumpCommand implements fc.AsyncCommand<BumpModel, BumpReal> {
  constructor(private readonly event: BumpEvent) {}

  check(model: Readonly<BumpModel>): boolean {
    return this.event.check(model as BumpModel)
  }

  async run(model: BumpModel, real: BumpReal): Promise<void> {
    const expected = this.event.expect(model)
    const service = real.harness.service
    const before = service.getSessionGeneration()
    const loggedBefore = real.harness.bumpLog.length
    const beforeCommand: BeforeCommand = {
      optionCount: service.getRuntimeConfigState().options.length,
      discoveryFetches: fetchCount(real.harness, 'GET', DISCOVERY_PATH),
      signedIn: model.signedIn,
    }
    const outcome = await settle(real, () => this.event.act(real, model))
    expect(outcome).toEqual(
      expected.rejects ? { ok: false, message: expected.rejects } : { ok: true }
    )
    const after = service.getSessionGeneration()
    expect(after).toBeGreaterThanOrEqual(before)
    expect(after > before).toBe(expected.bump)
    // The observer saw each advance once, in order, including two in one owner op.
    expect(real.harness.bumpLog.slice(loggedBefore).map(record => record.value)).toEqual(
      consecutive(before + 1, after)
    )
    this.event.next(model)
    expect(service.getCachedUserId() !== null).toBe(model.signedIn)
    // The model's environments are the real ones, so its next expectation is about the right one.
    expect(real.runtimeConfig.getActiveRuntimeConfigOptionId()).toBe(
      model.active === null ? null : optionId(real, model.active)
    )
    // The built-in Localhost option (`source: 'localhost'`) is not a stored profile.
    expect(
      service
        .getRuntimeConfigState()
        .options.filter(option => option.source === 'file')
        .map(option => option.externalRestApiBaseUrl)
        .sort()
    ).toEqual(modelRestUrls(real, model))
    this.event.verify?.(real, beforeCommand)
    const seen = bumpOutcomesSeen.get(this.event.id) ?? new Set<boolean>()
    seen.add(expected.bump)
    bumpOutcomesSeen.set(this.event.id, seen)
  }

  toString(): string {
    return this.event.label
  }
}

describe('tier 0 baseline', () => {
  it('T0-1 advances the generation exactly at the §2.2 bump sites', async () => {
    // E17 (a transient hop) and E18 (a `/me` rejection) need a live session, so they cannot
    // happen while an attempt waits; `appService.chatStoreTeamHop.test.ts`,
    // `appService.teamTransitionOwnership.test.ts` and `appService.sessionRejection*.test.ts`
    // characterize their bump sites.
    const environments = fc.constantFrom<EnvName>('A', 'B', 'C', 'D')
    const commands = fc.commands(
      [
        ...Object.values(bumpEvents).map(event => fc.constant(new BumpCommand(event))),
        fc.constantFrom<'E19' | 'E20'>('E19', 'E20').map(id => new BumpCommand(logoutEvent(id))),
        environments.map(target => new BumpCommand(selectEvent(target))),
        environments.map(target => new BumpCommand(handoffSelectEvent(target))),
        fc
          .constantFrom<'B' | 'D'>('B', 'D')
          .map(target => new BumpCommand(deleteOtherEvent(target))),
      ],
      { maxCommands: 16, size: 'max' }
    )
    bumpOutcomesSeen.clear()
    discoveryCommitsSeen = 0

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.boolean(),
        commands,
        async (scheduler, keptToken, generated) => {
          const harness = await createBrowserSignInHarness({ scheduler, keptToken })
          const runtimeConfig = await import('../config.js')
          await cleanUpAfter(async () => {
            // The hub's setup answer, with only its environment changed to D.
            const hubSetup = harness.routes[HUB_SETUP_ROUTE]
            if (!hubSetup) throw new Error('the harness has no hub setup route')
            harness.routes[HUB_SETUP_ROUTE] = async request => {
              const answer = (await (await hubSetup(request)).json()) as Record<string, unknown>
              return new Response(
                JSON.stringify({
                  ...answer,
                  externalRestApiBaseUrl: ENV_D_REST,
                  appName: 'Environment D',
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
              )
            }
            const model: BumpModel = {
              active: 'A',
              bExists: true,
              dExists: false,
              signedIn: false,
              storedA: keptToken,
            }
            await fc.asyncModelRun(
              () => ({ model, real: { harness, scheduler, runtimeConfig } }),
              generated
            )
          })
        }
      ),
      { numRuns: 24, seed: 24112026 }
    )

    // Coverage. Every reachable event ran, each conditional one was seen both bumping and not,
    // and E30 committed a discovery at least once. What runs depends on the seed, fast-check's
    // version (4.9.0) and `size: 'max'`, so a failure here means the generated runs no longer
    // reach an event: change the seed or the size, not the bump expectations. It is not a bump
    // regression; the per-command checks above catch those.
    expect([...bumpOutcomesSeen.keys()].sort()).toEqual(
      [
        'E13',
        'E14',
        'E15',
        'E16',
        'E19',
        'E20',
        'E21',
        'E22',
        'E23',
        'E24',
        'E25',
        'E26',
        'E27',
        'E28',
        'E29',
        'E30',
        'E31/E32',
      ].sort()
    )
    for (const id of CONDITIONAL_EVENTS) {
      expect({ id, outcomes: [...(bumpOutcomesSeen.get(id) ?? [])].sort() }).toEqual({
        id,
        outcomes: [false, true],
      })
    }
    expect(discoveryCommitsSeen).toBeGreaterThan(0)
  })

  it('T0-2 refuses setup and handoff, and skips restore, during a held password login', async () => {
    const harness = await createBrowserSignInHarness({ keptToken: true })
    const { service, envs } = harness
    // The held password login: its fetch waits on a deferred answer (no hold point names it).
    const passwordLoginAnswer = deferred<Response>()
    let passwordLoginReached = false
    harness.routes['POST /api/v1/auth/password-login'] = () => {
      passwordLoginReached = true
      return passwordLoginAnswer.promise
    }

    const login = service.passwordLogin('user-b@example.test', 'fake-password')
    await until(harness, () => passwordLoginReached, 'the password-login fetch')
    const generation = service.getSessionGeneration()

    await expect(
      service.completeDesktopSetup('user-b@example.test', 'fake-setup-authorization-token')
    ).rejects.toThrow(/^auth_transition_in_progress$/)
    await expect(
      service.selectRuntimeConfigForHandoff(envs.B.optionId, generation)
    ).rejects.toThrow(/^auth_transition_in_progress$/)
    await expect(
      service.saveRuntimeConfig(
        {
          externalRestApiBaseUrl: envs.B.restBaseUrl,
          rpcProxyBaseUrl: '',
          appName: 'Environment B',
        },
        generation
      )
    ).rejects.toThrow(/^auth_transition_in_progress$/)
    await expect(service.getSessionState()).resolves.toEqual({
      authenticated: false,
      me: null,
      sessionGeneration: generation,
    })
    expect(fetchCount(harness, 'GET', '/api/v1/me')).toBe(0)
    expect(service.getSessionGeneration()).toBe(generation)

    // The login fails with the edge's 401 (`authClient.passwordLogin.test.ts`). With no login in
    // progress, the same kept token is restored through `/me`: the skip came from the login.
    passwordLoginAnswer.resolve(
      new Response(JSON.stringify({ error: 'invalid_credentials' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' },
      })
    )
    await expect(login).rejects.toThrow(/httpStatus=401$/)
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me: { id: harnessDriverUsers.restore.id },
    })
    expect(fetchCount(harness, 'GET', '/api/v1/me')).toBe(1)
  })

  it('T0-5 keeps the binding through discovery on profile C, and switches the profile id with no bump on the legacy profiles', async () => {
    const harness = await createBrowserSignInHarness()
    const { service, envs } = harness
    const runtimeConfig = await import('../config.js')
    await service.selectRuntimeConfig(envs.C.optionId)
    const generation = service.getSessionGeneration()
    expect(runtimeConfig.getActiveRuntimeConfigOptionId()).toBe(envs.C.optionId)
    expect(service.getRuntimeConfigState().currentConfig).toMatchObject({
      externalRestApiBaseUrl: envs.C.restBaseUrl,
      rpcProxyBaseUrl: '',
    })

    await service.getDependenciesHealth()

    // The signed-out discovery commit ran: it saved the discovered RPC URL on profile C.
    expect(fetchCount(harness, 'GET', '/api/v1/desktop/environment')).toBe(1)
    expect(service.getRuntimeConfigState().currentConfig).toMatchObject({
      externalRestApiBaseUrl: envs.C.restBaseUrl,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
    })
    expect(runtimeConfig.getActiveRuntimeConfigOptionId()).toBe(envs.C.optionId)
    expect(service.getSessionGeneration()).toBe(generation)

    await cleanupBrowserSignInHarness()
    const legacy = await createBrowserSignInHarness({ legacyDuplicateProfiles: true })
    const legacyConfig = await import('../config.js')
    const legacyProfiles = legacy.service
      .getRuntimeConfigState()
      .options.filter(
        option => new URL(option.externalRestApiBaseUrl).host === 'api-x.example.test'
      )
    expect(legacyProfiles.map(option => option.appName)).toEqual(['Legacy slash', 'Legacy bare'])
    const [slash, bare] = legacyProfiles
    const legacyGeneration = legacy.service.getSessionGeneration()
    expect(legacyConfig.getActiveRuntimeConfigOptionId()).toBe(bare?.id)

    await legacy.service.getDependenciesHealth()

    expect(fetchCount(legacy, 'GET', '/api/v1/desktop/environment')).toBe(1)
    expect(legacyConfig.getActiveRuntimeConfigOptionId()).toBe(slash?.id)
    expect(legacy.service.getSessionGeneration()).toBe(legacyGeneration)
  })

  it('T0-6 has not moved the generation while the restore commit awaits the chat-store bind', async () => {
    const harness = await createBrowserSignInHarness({ keptToken: true })
    const { service } = harness
    const generation = service.getSessionGeneration()
    const bind = harness.hold('restoreChatBind')

    const restore = service.getSessionState()
    await until(harness, () => bind.reached, "the restore's chat-store bind")
    expect(fetchCount(harness, 'GET', '/api/v1/me')).toBe(1)
    expect(service.getSessionGeneration()).toBe(generation)

    bind.release()
    await expect(restore).resolves.toMatchObject({
      authenticated: true,
      me: { id: harnessDriverUsers.restore.id },
    })
    expect(service.getSessionGeneration()).toBe(generation + 1)
  })

  it('T0-7 keeps an in-memory session when setSessionToken rejects during password login', async () => {
    const harness = await createBrowserSignInHarness()
    const { service } = harness
    const write = harness.hold('installTokenWrite')

    const login = service.passwordLogin('user-b@example.test', 'fake-password')
    await until(harness, () => write.reached, "the install's token write")
    write.release(new Error('fake keychain write failure'))

    await expect(login).rejects.toThrow(/^fake keychain write failure$/)
    expect(harness.tokenWrites).toHaveLength(1)
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me: { id: harnessDriverUsers.password.id },
    })
  })
})

describe('the generation hook and the test seams', () => {
  const OBSERVER_FAILED = '[AppService] The session generation observer failed:'

  it('reports every generation advance once, including two in one owner op', async () => {
    const harness = await createBrowserSignInHarness()
    const { service } = harness
    await service.passwordLogin('user-b@example.test', 'fake-password')
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
    expect(harness.bumpLog.map(record => record.value)).toEqual(
      consecutive(1, service.getSessionGeneration())
    )
    const before = service.getSessionGeneration()
    const logged = harness.bumpLog.length

    await service.logout()

    // One owner op, two advances: logout's own, then `clearAuthenticatedSessionState`'s.
    expect(harness.bumpLog.slice(logged).map(record => record.value)).toEqual([
      before + 1,
      before + 2,
    ])
    expect(harness.bumpLog.at(-1)?.value).toBe(service.getSessionGeneration())
  })

  it('logs and survives an observer that throws', async () => {
    const failure = new Error('fake observer failure')
    let failNext = false
    const harness = await createBrowserSignInHarness({
      onSessionGenerationAdvanced: () => {
        if (!failNext) return
        failNext = false
        throw failure
      },
    })
    const { service } = harness
    await service.passwordLogin('user-b@example.test', 'fake-password')
    const sessionToken = harness.tokenWrites.at(-1)?.value
    expect(sessionToken).toMatch(/^fake-password-session-token-/)
    // The harness's spy on `console.warn`: its calls from here on are logout's.
    const warn = vi.spyOn(console, 'warn')
    const warnedBefore = warn.mock.calls.length
    const before = service.getSessionGeneration()

    // The observer throws at logout's first advance, the first statement of its owner op.
    failNext = true
    await expect(service.logout()).resolves.toBe(before + 2)

    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    expect(harness.bumpLog.slice(-2).map(record => record.value)).toEqual([before + 1, before + 2])
    const warnings = warn.mock.calls.slice(warnedBefore)
    expect(warnings).toEqual([[OBSERVER_FAILED, failure]])
    const text = format(...(warnings[0] ?? []))
    for (const { value: token } of harness.tokenWrites) expect(text).not.toContain(token)
  })

  it('reads session presence without restoring', async () => {
    const harness = await createBrowserSignInHarness({ keptToken: true })
    const { service } = harness

    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    await harness.drain()
    expect(harness.tokenReads).toHaveLength(0)
    expect(fetchCount(harness, 'GET', '/api/v1/me')).toBe(0)

    // The kept token was there to read: a restore reads it and signs in.
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me: { id: harnessDriverUsers.restore.id },
    })
    expect(harness.tokenReads).toHaveLength(1)
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
  })

  it("shows the restore commit's half-written session at the chat-store bind", async () => {
    const harness = await createBrowserSignInHarness({ keptToken: true })
    const { service } = harness
    const generation = service.getSessionGeneration()
    const bind = harness.hold('restoreChatBind')

    const restore = service.getSessionState()
    await until(harness, () => bind.reached, "the restore's chat-store bind")
    // The token is set and the principal is not yet: the half-state `getCachedUserId` hides.
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: false })
    expect(service.getCachedUserId()).toBeNull()
    expect(service.getSessionGeneration()).toBe(generation)
    expect(harness.bumpLog).toEqual([])

    bind.release()
    await expect(restore).resolves.toMatchObject({ authenticated: true })
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
    expect(harness.bumpLog.map(record => record.value)).toEqual([generation + 1])
  })

  it('settles the owner queue, including ops queued while settling', async () => {
    const harness = await createBrowserSignInHarness()
    const { service } = harness
    const before = service.getSessionGeneration()

    const first = service.logout()
    const settled = service.whenAuthCommitsSettled()
    const second = service.logout()
    await settled

    // Both logouts ran to their end (two advances each) before the wait resolved.
    expect(service.getSessionGeneration()).toBe(before + 4)
    expect(harness.bumpLog.map(record => record.value)).toEqual(consecutive(before + 1, before + 4))
    await expect(first).resolves.toBe(before + 2)
    await expect(second).resolves.toBe(before + 4)
  })
})

describe('the harness', () => {
  it('moves the wall clock alone, or with the timers it fires in due order', () => {
    const clock = new FakeBrowserSignInClock(1_000)
    const fired: Array<[name: string, wallMs: number]> = []
    clock.setTimer(() => fired.push(['late', clock.now()]), 200)
    const cleared = clock.setTimer(() => fired.push(['cleared', clock.now()]), 50)
    clock.setTimer(() => fired.push(['early', clock.now()]), 100)
    clock.clearTimer(cleared)

    // The wall clock moves, and is set back, without any timer firing.
    clock.advance(500, 'wallOnly')
    expect(clock.now()).toBe(1_500)
    clock.advance(-300, 'wallOnly')
    expect(clock.now()).toBe(1_200)
    expect(fired).toEqual([])

    // The timers keep their own schedule: 'early' is due 100 ms after it was set, whatever the
    // wall clock did meanwhile, and fires with the wall clock moved by the same 100 ms.
    clock.advance(150, 'timers')
    expect(fired).toEqual([['early', 1_300]])
    expect(clock.now()).toBe(1_350)
    clock.advance(50, 'timers')
    expect(fired).toEqual([
      ['early', 1_300],
      ['late', 1_400],
    ])
    expect(clock.pendingTimers()).toBe(0)
    expect(() => clock.advance(-1, 'timers')).toThrow(/cannot go back/)
  })

  it("drives the attempt store's deadline in either mode", () => {
    const binding = {
      environmentKey: 'env-a',
      profileId: null,
      restBaseUrl: 'https://a.example.test',
    }
    const record = (attempts: BrowserSignInAttempts) =>
      attempts.record({ state: 'fake-state', verifier: 'fake-verifier', binding, generation: 1 })
    const build = (clock: FakeBrowserSignInClock) =>
      new BrowserSignInAttempts({ push: () => undefined, warn: () => undefined, clock })

    // Wall clock only: the timer has not fired, and a read applies the deadline itself.
    const wallClock = new FakeBrowserSignInClock()
    const byWall = build(wallClock)
    const wallId = record(byWall)
    wallClock.advance(BROWSER_SIGN_IN_DEADLINE_MS, 'wallOnly')
    expect(wallClock.pendingTimers()).toBe(1)
    expect(byWall.current()?.phase).toBe('waiting')
    expect(byWall.snapshot()).toEqual({ attemptId: wallId, phase: 'ended', outcome: 'timed_out' })
    expect(wallClock.pendingTimers()).toBe(0)

    // Timers: the deadline timer itself ends the attempt, before any read.
    const timerClock = new FakeBrowserSignInClock()
    const byTimer = build(timerClock)
    record(byTimer)
    timerClock.advance(BROWSER_SIGN_IN_DEADLINE_MS, 'timers')
    expect(byTimer.current()?.phase).toBe('ended')
  })

  it('cleans up newest first and leaves the calling test its own stubs', async () => {
    const hubVariable = 'MEMBER_REGISTRATION_SERVICE_BASE_URL'
    const savedHub = process.env[hubVariable]
    const ownFetch = vi.fn()
    const probe = 'browserSignInHarnessProbe'
    vi.stubGlobal('fetch', ownFetch)
    vi.stubGlobal(probe, 'kept')
    process.env[hubVariable] = 'https://own-hub.example.test'
    try {
      await createBrowserSignInHarness()
      await createBrowserSignInHarness()
      // Both harnesses are live: the newest one's fetch and hub are in place.
      expect(globalThis.fetch).not.toBe(ownFetch)
      expect(process.env[hubVariable]).toBe('https://hub.example.test')

      await cleanupBrowserSignInHarness()

      expect(globalThis.fetch).toBe(ownFetch)
      expect(Reflect.get(globalThis, probe)).toBe('kept')
      expect(process.env[hubVariable]).toBe('https://own-hub.example.test')
    } finally {
      vi.unstubAllGlobals()
      if (savedHub === undefined) delete process.env[hubVariable]
      else process.env[hubVariable] = savedHub
    }
  })
})
