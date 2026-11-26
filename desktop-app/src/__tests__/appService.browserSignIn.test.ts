import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { type IncomingHttpHeaders, createServer } from 'node:http'
import { format } from 'node:util'
import {
  type BrowserSignInHarness,
  FakeBrowserSignInClock,
  cleanupBrowserSignInHarness,
  createBrowserSignInHarness,
  harnessDriverUsers,
} from '../../testSupport/browserSignInHarness.js'
import {
  type EdgeContractRecord,
  type EdgeRecordKey,
  deriveEdgeRecord,
  deriveEdgeRecordStatus,
  edgeResponse,
  readEdgeRecord,
} from '../../testSupport/edgeContractRecords.js'
import { AuthClient } from '../authClient.js'
import {
  BROWSER_SIGN_IN_DEADLINE_MS,
  BrowserSignInAttempts,
  createBrowserSignInSecrets,
  createDesktopLoginLinkHandler,
} from '../browserSignIn.js'
import {
  type LoginMethodsHttpAnswer,
  type RedeemHttpAnswer,
  buildDesktopLoginCodeLink,
  buildDesktopLoginErrorLink,
  parseDesktopLoginPageUrl,
} from '../browserSignInModel.js'
import type { BrowserSignInEnd, BrowserSignInSnapshot, LoginMethodsModel } from '../types.js'

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

/** A boundary change away from A clears A's saved token (`appService.ts:2294`). */
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
    // The model leaves out `getSessionState`'s 5 s retry gate (`appService.ts:4082-4087`): it
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
    // `evenfire://logout` reaches the same `AppService.logout()` through `main.ts:120-123`.
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

const METHODS_ROUTE = 'GET /api/v1/auth/methods'
const METHODS_PATH = '/api/v1/auth/methods'
const BOTH_METHODS = 'GET /api/v1/auth/methods password-and-oidc'
const PASSWORD_METHOD = 'GET /api/v1/auth/methods password'
const METHODS_UNAVAILABLE = 'GET /api/v1/auth/methods unavailable'
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/

type StartOutcome = 'records' | 'methods_unavailable' | 'browser_sign_in_not_offered'
type MethodsAnswerRow = Readonly<{
  /** The record key or the derivation's label; adversarial input says so. */
  label: string
  answer: () => Response
  /** What `getLoginMethodsAt` hands over. */
  http: LoginMethodsHttpAnswer
  model: LoginMethodsModel
  start: StartOutcome
}>

function recordedOidc(): { label: string; signInUrl: string } {
  const { oidc } = readEdgeRecord(BOTH_METHODS).body as {
    oidc: { label: string; signInUrl: string }
  }
  return { label: oidc.label, signInUrl: oidc.signInUrl }
}

/** A record answered as it is, with the answer the fetching code hands over for it. */
function recordedRow(
  label: string,
  record: EdgeContractRecord,
  model: LoginMethodsModel,
  start: StartOutcome
): MethodsAnswerRow {
  const http: LoginMethodsHttpAnswer =
    model.kind === 'unreachable'
      ? { status: 'unreachable' }
      : record.status === 404
        ? { status: 404 }
        : { status: 200, body: record.body }
  return { label, answer: () => edgeResponse(record), http, model, start }
}

/** A labelled derivation answered as it is. `derive` gets the row's label, typed once. */
function derivedRow(
  label: string,
  derive: (label: string) => EdgeContractRecord,
  model: LoginMethodsModel,
  start: StartOutcome
): MethodsAnswerRow {
  return recordedRow(label, derive(label), model, start)
}

/** Input no producer emits, built by hand (T1's adversarial-input exception). */
function adversarialRow(label: string, answer: () => Response): MethodsAnswerRow {
  return {
    label: `adversarial: ${label}`,
    answer,
    http: { status: 'unreachable' },
    model: { kind: 'unreachable' },
    start: 'methods_unavailable',
  }
}

/** A network failure as undici reports it. */
function networkFailure(): TypeError {
  const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  return new TypeError('fetch failed', { cause })
}

const UNREACHABLE: LoginMethodsModel = { kind: 'unreachable' }
const PASSWORD_FORM: LoginMethodsModel = { kind: 'methods', provider: null, password: true }

/**
 * Design §10.1's answers as the fetching code reads them, with what start does on each (A3-10).
 * Every 4xx but a 404, every 5xx, a network failure and a body that is not a JSON object (an
 * empty body reads as `{}`) are `unreachable`: "Can't reach this environment", with Retry, no
 * form and no guess.
 */
const METHODS_ANSWERS: ReadonlyArray<MethodsAnswerRow> = [
  recordedRow(
    'password-and-oidc',
    readEdgeRecord(BOTH_METHODS),
    { kind: 'methods', provider: { label: recordedOidc().label }, password: true },
    'records'
  ),
  derivedRow(
    'oidc-only',
    label =>
      deriveEdgeRecord(BOTH_METHODS, label, body => {
        const recorded = body as { methods: string[] }
        return { ...recorded, methods: recorded.methods.filter(method => method !== 'password') }
      }),
    { kind: 'methods', provider: { label: recordedOidc().label }, password: false },
    'records'
  ),
  recordedRow(
    'password',
    readEdgeRecord(PASSWORD_METHOD),
    PASSWORD_FORM,
    'browser_sign_in_not_offered'
  ),
  // A server older than the endpoint still accepts passwords.
  recordedRow(
    'not-found',
    readEdgeRecord('GET /api/v1/auth/methods not-found'),
    PASSWORD_FORM,
    'browser_sign_in_not_offered'
  ),
  derivedRow(
    'nothing-usable:empty',
    label =>
      deriveEdgeRecord(PASSWORD_METHOD, label, body => ({
        ...(body as object),
        methods: [],
      })),
    { kind: 'misconfigured' },
    'browser_sign_in_not_offered'
  ),
  recordedRow(
    'unavailable',
    readEdgeRecord(METHODS_UNAVAILABLE),
    UNREACHABLE,
    'methods_unavailable'
  ),
  derivedRow(
    'unavailable:status-401',
    label => deriveEdgeRecordStatus(METHODS_UNAVAILABLE, label, 401),
    UNREACHABLE,
    'methods_unavailable'
  ),
  derivedRow(
    'unavailable:status-429',
    label => deriveEdgeRecordStatus(METHODS_UNAVAILABLE, label, 429),
    UNREACHABLE,
    'methods_unavailable'
  ),
  derivedRow(
    'not-an-object:methods-list-as-body',
    label => deriveEdgeRecord(BOTH_METHODS, label, body => (body as { methods: unknown }).methods),
    UNREACHABLE,
    'methods_unavailable'
  ),
  // R-23: `requestJson` reads an empty body as `{}`, which lists no method, so the screen is
  // "isn't set up correctly", with Retry, not "Can't reach this environment".
  {
    label: 'adversarial: an empty 200 body',
    answer: () => new Response('', { status: 200 }),
    http: { status: 200, body: {} },
    model: { kind: 'misconfigured' },
    start: 'browser_sign_in_not_offered',
  },
  adversarialRow(
    'a 200 whose body is not JSON',
    () =>
      new Response('<!doctype html><title>Sign in</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
  ),
  adversarialRow('a network failure (ECONNRESET)', () => {
    throw networkFailure()
  }),
  adversarialRow('a timeout', () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }),
]

function methodsFetches(harness: BrowserSignInHarness) {
  return harness.fetches.filter(
    record => record.value.method === 'GET' && new URL(record.value.url).pathname === METHODS_PATH
  )
}

/** Every snapshot pushed for `attemptId`, in order. */
function snapshotsOf(harness: BrowserSignInHarness, attemptId: number): BrowserSignInSnapshot[] {
  return harness.pushes
    .map(record => record.value)
    .filter(snapshot => snapshot.attemptId === attemptId)
}

/** The end states pushed for `attemptId`, in order. */
function endStatesOf(harness: BrowserSignInHarness, attemptId: number): string[] {
  return snapshotsOf(harness, attemptId).flatMap(snapshot =>
    snapshot.phase === 'ended' ? [snapshot.outcome] : []
  )
}

function openedPage(harness: BrowserSignInHarness, index: number) {
  const opened = harness.opens[index]
  if (!opened) throw new Error(`no browser open number ${index + 1}`)
  return parseDesktopLoginPageUrl(opened.value)
}

describe('browser sign-in start, cancel and the methods read', () => {
  it.each(METHODS_ANSWERS.map(row => [row.label, row] as const))(
    'hands %s over as a plain answer',
    async (_label, row) => {
      const harness = await createBrowserSignInHarness()
      harness.routes[METHODS_ROUTE] = row.answer

      // A trailing slash on the bound URL does not double the path's.
      const answer = await new AuthClient().getLoginMethodsAt(`${harness.envs.A.restBaseUrl}/`)

      // Strict: a plain answer, never an `ApiError`.
      expect(answer).toStrictEqual(row.http)
      // Sent once, with no retry, to the URL it was given.
      expect(methodsFetches(harness).map(record => record.value.url)).toEqual([
        `${harness.envs.A.restBaseUrl}${METHODS_PATH}`,
      ])
    }
  )

  it.each(METHODS_ANSWERS.map(row => [row.label, row] as const))(
    'reads %s as its login model',
    async (_label, row) => {
      const harness = await createBrowserSignInHarness({ linksAvailable: true })
      const { service } = harness
      harness.routes[METHODS_ROUTE] = row.answer
      const generation = service.getSessionGeneration()

      await expect(service.getLoginMethods()).resolves.toEqual({ model: row.model, generation })

      // The read advances nothing and starts nothing.
      expect(service.getSessionGeneration()).toBe(generation)
      expect(methodsFetches(harness)).toHaveLength(1)
      await harness.drain()
      expect(harness.pushes).toEqual([])
      expect(harness.opens).toEqual([])
    }
  )

  it.each(METHODS_ANSWERS.map(row => [row.label, row] as const))(
    'start on %s',
    async (_label, row) => {
      const harness = await createBrowserSignInHarness({ linksAvailable: true })
      const { service } = harness
      harness.routes[METHODS_ROUTE] = row.answer

      const start = service.startBrowserSignIn()

      if (row.start === 'records') {
        await expect(start).resolves.toEqual({ attemptId: 1 })
        await harness.drain()
        expect(harness.pushes.map(record => record.value)).toEqual([
          { attemptId: 1, phase: 'waiting' },
        ])
        expect(harness.opens).toHaveLength(1)
      } else {
        await expect(start).rejects.toThrow(new RegExp(`^${row.start}$`))
        await harness.drain()
        expect(harness.pushes).toEqual([])
        expect(harness.opens).toEqual([])
      }
      // Either way, start made its own read, once.
      expect(methodsFetches(harness)).toHaveLength(1)
    }
  )

  it('opens a signInUrl on another origin than the REST URL', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { signInUrl } = recordedOidc()
    const restOrigin = new URL(envs.A.restBaseUrl).origin
    // As in every real deployment: the page on `profile.…`, the REST URL on another host.
    expect(new URL(signInUrl).origin).not.toBe(restOrigin)

    await expect(service.startBrowserSignIn()).resolves.toEqual({ attemptId: 1 })

    expect(harness.opens).toHaveLength(1)
    expect(openedPage(harness, 0)).toMatchObject({ signInUrl })
    expect(new URL(harness.opens[0]?.value ?? '').origin).not.toBe(restOrigin)
  })

  it('refuses the methods read without fetching when no environment is configured', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    await service.clearRuntimeConfigSelection()
    const generation = service.getSessionGeneration()

    await expect(service.getLoginMethods()).rejects.toThrow(/^desktop_setup_required$/)
    await expect(service.startBrowserSignIn()).rejects.toThrow(/^desktop_setup_required$/)

    // Start refuses before its generation advance (D3).
    expect(service.getSessionGeneration()).toBe(generation)
    await harness.drain()
    expect(methodsFetches(harness)).toEqual([])
    expect(harness.pushes).toEqual([])

    // Once an environment is selected again, the same read fetches.
    await service.selectRuntimeConfig(envs.A.optionId)
    await expect(service.getLoginMethods()).resolves.toMatchObject({
      model: { kind: 'methods' },
    })
    expect(methodsFetches(harness)).toHaveLength(1)
  })

  it('returns the generation captured when the read was dispatched', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service } = harness
    const methods = harness.hold('methods')
    const generation = service.getSessionGeneration()

    const read = service.getLoginMethods()
    await until(harness, () => methods.reached, 'the methods read')
    await service.logout()
    expect(service.getSessionGeneration()).toBeGreaterThan(generation)
    methods.release(edgeResponse(readEdgeRecord(BOTH_METHODS)))

    await expect(read).resolves.toEqual({
      model: { kind: 'methods', provider: { label: recordedOidc().label }, password: true },
      generation,
    })
  })

  // A3-65: the add form's `type="url"` input takes this value. Its environment key is not the
  // active one's, so the save takes `applyRuntimeEnvironmentChange`, which advances the
  // generation before `validateRuntimeConfig` refuses the URL. The renderer's G2-15d test feeds
  // this rejection, as Electron wraps it.
  it('G2-15d producer: saving ftp://api.example.test rejects after a bump', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const generation = service.getSessionGeneration()
    const logged = harness.bumpLog.length

    await expect(
      service.saveRuntimeConfig({
        externalRestApiBaseUrl: 'ftp://api.example.test',
        rpcProxyBaseUrl: '',
        appName: 'Environment FTP',
      })
    ).rejects.toThrow(/^externalRestApiBaseUrl must be a valid http\(s\) URL$/)

    expect(harness.bumpLog.slice(logged).map(record => record.value)).toEqual([generation + 1])
    expect(service.getSessionGeneration()).toBe(generation + 1)
    // The environment is unchanged: A stays active, and its model is read at the new generation.
    expect(service.getRuntimeConfigState().activeOptionId).toBe(envs.A.optionId)
    await expect(service.getLoginMethods()).resolves.toMatchObject({ generation: generation + 1 })
  })

  it('opens a page URL whose fragment carries a 43-character challenge and state', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })

    await expect(harness.service.startBrowserSignIn()).resolves.toEqual({ attemptId: 1 })

    const page = openedPage(harness, 0)
    expect(page).toMatchObject({
      signInUrl: recordedOidc().signInUrl,
      challenge: SECRET_SHAPE,
      state: SECRET_SHAPE,
    })
    expect(page?.challenge).not.toBe(page?.state)
  })

  it('D3 ends a waiting attempt replaced when another starts', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service } = harness

    await expect(service.startBrowserSignIn()).resolves.toEqual({ attemptId: 1 })
    await expect(service.startBrowserSignIn()).resolves.toEqual({ attemptId: 2 })
    await harness.drain()

    expect(harness.pushes.map(record => record.value)).toEqual([
      { attemptId: 1, phase: 'waiting' },
      { attemptId: 1, phase: 'ended', outcome: 'replaced' },
      { attemptId: 2, phase: 'waiting' },
    ])
  })

  it('cancels a waiting attempt, and does nothing without one', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service } = harness
    expect(service.cancelBrowserSignIn()).toEqual({ attemptId: null, phase: 'idle' })

    await expect(service.startBrowserSignIn()).resolves.toEqual({ attemptId: 1 })
    const cancelled = { attemptId: 1, phase: 'ended', outcome: 'cancelled' }
    expect(service.cancelBrowserSignIn()).toEqual(cancelled)
    // Once ended, a second cancel changes nothing.
    expect(service.cancelBrowserSignIn()).toEqual(cancelled)
    await harness.drain()
    expect(endStatesOf(harness, 1)).toEqual(['cancelled'])
  })

  it('G2-4 refuses to start while signed in', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service } = harness
    await service.passwordLogin('user-b@example.test', 'fake-password')
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })

    await expect(service.startBrowserSignIn()).rejects.toThrow(/^browser_sign_in_requires_signout$/)
    await harness.drain()
    expect(methodsFetches(harness)).toHaveLength(0)
    expect(harness.opens).toHaveLength(0)

    // Signed out, the same start reads the methods and opens the browser.
    await service.logout()
    await expect(service.startBrowserSignIn()).resolves.toEqual({ attemptId: 1 })
    expect(methodsFetches(harness)).toHaveLength(1)
    expect(harness.opens).toHaveLength(1)
  })

  const ENV_A_SIGN_IN_URL = 'env-a-sign-in-url'

  it(`G2-5a reads methods for the binding at start (${ENV_A_SIGN_IN_URL})`, async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { signInUrl } = recordedOidc()
    const envASignInUrl = `https://profile-a.example.test${new URL(signInUrl).pathname}`
    const envA = deriveEdgeRecord(BOTH_METHODS, ENV_A_SIGN_IN_URL, body => {
      const recorded = body as { oidc: Record<string, unknown> }
      return { ...recorded, oidc: { ...recorded.oidc, signInUrl: envASignInUrl } }
    })
    const restOriginA = new URL(envs.A.restBaseUrl).origin
    harness.routes[METHODS_ROUTE] = request =>
      edgeResponse(
        new URL(request.url).origin === restOriginA ? envA : readEdgeRecord(BOTH_METHODS)
      )

    await expect(service.getLoginMethods()).resolves.toMatchObject({
      model: { kind: 'methods', provider: { label: recordedOidc().label } },
    })
    expect(methodsFetches(harness).map(record => record.value.url)).toEqual([
      `${envs.A.restBaseUrl}${METHODS_PATH}`,
    ])
    await service.selectRuntimeConfig(envs.B.optionId)

    await expect(service.startBrowserSignIn()).resolves.toEqual({ attemptId: 1 })

    expect(methodsFetches(harness)[1]?.value.url).toBe(`${envs.B.restBaseUrl}${METHODS_PATH}`)
    expect(harness.opens[0]?.value.startsWith(`${signInUrl}#`)).toBe(true)
  })

  it.each(['an environment switch', 'a password-login start'] as const)(
    'G2-5b rejects a start whose methods read crossed %s',
    async event => {
      const harness = await createBrowserSignInHarness({ linksAvailable: true })
      const { service, envs } = harness
      const methods = harness.hold('methods')

      const start = service.startBrowserSignIn()
      await until(harness, () => methods.reached, "start's methods read")
      if (event === 'an environment switch') await service.selectRuntimeConfig(envs.B.optionId)
      else await service.passwordLogin('user-b@example.test', 'fake-password')
      methods.release(edgeResponse(readEdgeRecord(BOTH_METHODS)))

      await expect(start).rejects.toThrow(/^stale_session_generation$/)
      await harness.drain()
      expect(methodsFetches(harness)).toHaveLength(1)
      expect(harness.pushes).toEqual([])
      expect(harness.opens).toEqual([])
    }
  )

  it('G2-5c ends the attempt failed when the browser cannot open', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const open = harness.hold('open')

    const start = harness.service.startBrowserSignIn()
    await until(harness, () => open.reached, 'the browser open')
    open.release(new Error('fake browser open failure'))

    await expect(start).rejects.toThrow(/^browser_open_failed$/)
    await harness.drain()
    expect(harness.opens).toHaveLength(1)
    expect(snapshotsOf(harness, 1)).toEqual([
      { attemptId: 1, phase: 'waiting' },
      { attemptId: 1, phase: 'ended', outcome: 'failed' },
    ])
    expect(endStatesOf(harness, 1)).toEqual(['failed'])
    // The failure is logged, with neither the page URL nor its state (D18).
    const state = openedPage(harness, 0)?.state ?? ''
    expect(state).toMatch(SECRET_SHAPE)
    expect(harness.secretsSeen).toContain('[AppService] Browser sign-in could not open the browser')
    expect(harness.secretsSeen.filter(text => text.includes(state))).toEqual([])
  })

  it('G2-5d keys the open failure on its own attempt', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service } = harness
    const firstOpen = harness.hold('open')

    const first = service.startBrowserSignIn()
    await until(harness, () => firstOpen.reached, "a1's browser open")
    expect(service.cancelBrowserSignIn()).toEqual({
      attemptId: 1,
      phase: 'ended',
      outcome: 'cancelled',
    })
    await expect(service.startBrowserSignIn()).resolves.toEqual({ attemptId: 2 })
    firstOpen.release(new Error('fake browser open failure'))

    await expect(first).rejects.toThrow(/^browser_open_failed$/)
    await harness.drain()
    expect(endStatesOf(harness, 1)).toEqual(['cancelled'])
    expect(snapshotsOf(harness, 2)).toEqual([{ attemptId: 2, phase: 'waiting' }])
    // One browser open per attempt (C3), each with its own state.
    expect(harness.opens).toHaveLength(2)
    expect(openedPage(harness, 0)?.state).not.toBe(openedPage(harness, 1)?.state)
  })

  it('G2-16 offers no browser sign-in where links cannot arrive', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: false })
    const { service } = harness

    // The answer offers both methods; only the password form shows.
    await expect(service.getLoginMethods()).resolves.toMatchObject({ model: PASSWORD_FORM })
    expect(methodsFetches(harness)).toHaveLength(1)

    await expect(service.startBrowserSignIn()).rejects.toThrow(/^browser_sign_in_unavailable_here$/)
    await harness.drain()
    expect(methodsFetches(harness)).toHaveLength(1)
    expect(harness.pushes).toEqual([])
    expect(harness.opens).toEqual([])
  })
})

const REDEEM_ROUTE = 'POST /api/v1/oidc/desktop-sign-in/redeem'
const REDEEM_PATH = '/api/v1/oidc/desktop-sign-in/redeem'
const REDEEM_SIGNED_IN: EdgeRecordKey = 'POST /api/v1/oidc/desktop-sign-in/redeem signed-in'
const REDEEM_REFUSED: EdgeRecordKey =
  'POST /api/v1/oidc/desktop-sign-in/redeem refused-account-disabled'
const SIGNED_IN_WITHOUT_ME_ID = 'signed-in-without-me-id'
const LINK_HANDLING_FAILED = '[AppService] Browser sign-in link handling failed:'
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

function redeemFetches(harness: BrowserSignInHarness) {
  return harness.fetches.filter(
    record => record.value.method === 'POST' && new URL(record.value.url).pathname === REDEEM_PATH
  )
}

/** The code the edge recorded issuing, of the shape PR 2's link builder requires. */
function recordedCode(): string {
  const { code } = readEdgeRecord('POST /api/v1/oidc/profile-flow/complete desktop-code-issued')
    .body as { code: string }
  return code
}

/** The session token the edge recorded for `signed-in`. */
function recordedSessionToken(): string {
  return (readEdgeRecord(REDEEM_SIGNED_IN).body as { token: string }).token
}

/** The recorded 200 with `me.id` removed (Review Focus 4): the edge passes it; Desktop cannot install it. */
function signedInWithoutMeId(): EdgeContractRecord {
  return deriveEdgeRecord(REDEEM_SIGNED_IN, SIGNED_IN_WITHOUT_ME_ID, body => {
    const { me, ...rest } = body as { me: Record<string, unknown> }
    const { id: _id, ...meWithoutId } = me
    return { ...rest, me: meWithoutId }
  })
}

/** A code link from PR 2's builder, as the Profile UI sends it. */
function codeLink(state: string, environment: string): string {
  return buildDesktopLoginCodeLink({ state, code: recordedCode(), environment })
}

/** Starts an attempt and reads its state from the page URL it opened. */
async function startAttempt(
  harness: BrowserSignInHarness
): Promise<{ attemptId: number; state: string }> {
  const { attemptId } = await harness.service.startBrowserSignIn()
  const state = openedPage(harness, harness.opens.length - 1)?.state
  if (!state) throw new Error(`attempt ${attemptId} opened no page with a state`)
  return { attemptId, state }
}

/** The service's own `AuthClient`, a private field, so a test sees what its transport returned. */
function serviceAuthClient(harness: BrowserSignInHarness): AuthClient {
  return (harness.service as unknown as { authClient: AuthClient }).authClient
}

type RedeemRecordRow = Readonly<{
  /** The record key, or the derivation's label. */
  label: string
  record: () => EdgeContractRecord
  end: BrowserSignInEnd
}>

/** What `redeemDesktopSignInAt` hands over for a record the edge answered as it is. */
function transportAnswer(record: EdgeContractRecord): RedeemHttpAnswer {
  return record.status === 200
    ? { status: 200, body: record.body }
    : { status: record.status, bodyText: JSON.stringify(record.body) }
}

function recordedRedeemRow(key: EdgeRecordKey, end: BrowserSignInEnd): RedeemRecordRow {
  return { label: key, record: () => readEdgeRecord(key), end }
}

/**
 * D9 through D17, end to end: each recorded redeem answer, sent by the edge as it is, with its
 * §5.2 end state. The last row is R-4's: a 200 the edge passes and Desktop cannot install.
 */
const REDEEM_RECORDS: ReadonlyArray<RedeemRecordRow> = [
  recordedRedeemRow(REDEEM_SIGNED_IN, { outcome: 'signed_in' }),
  recordedRedeemRow('POST /api/v1/oidc/desktop-sign-in/redeem invalid', { outcome: 'failed' }),
  recordedRedeemRow(REDEEM_REFUSED, {
    outcome: 'refused',
    reason: (readEdgeRecord(REDEEM_REFUSED).body as { reason: 'account_disabled' }).reason,
  }),
  recordedRedeemRow('POST /api/v1/oidc/desktop-sign-in/redeem unavailable', {
    outcome: 'failed',
    reason: 'no_longer_available',
  }),
  recordedRedeemRow('POST /api/v1/oidc/desktop-sign-in/redeem upgrade-required', {
    outcome: 'failed',
  }),
  recordedRedeemRow('POST /api/v1/oidc/desktop-sign-in/redeem issuance-unavailable', {
    outcome: 'failed',
  }),
  recordedRedeemRow('POST /api/v1/oidc/desktop-sign-in/redeem rate-limited', {
    outcome: 'failed',
  }),
  { label: SIGNED_IN_WITHOUT_ME_ID, record: signedInWithoutMeId, end: { outcome: 'failed' } },
]

describe('browser sign-in link acceptance, redeem and install', () => {
  it('G2-1 redeems a duplicated code link once', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const link = codeLink(state, envs.A.restBaseUrl)

    // The handoff page fires the link on load and again from its button (design §8). Both reach
    // the sync pre-match before the first acceptance op runs.
    expect(service.acceptDesktopLoginLink(link)).toBe(true)
    expect(service.acceptDesktopLoginLink(link)).toBe(true)
    await harness.drain()

    expect(redeemFetches(harness)).toHaveLength(1)
    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
    expect(harness.tokenWrites.map(write => write.value)).toEqual([recordedSessionToken()])
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
    // Once the attempt has left `waiting`, the pre-match drops the same link.
    expect(service.acceptDesktopLoginLink(link)).toBe(false)
    await harness.drain()
    expect(redeemFetches(harness)).toHaveLength(1)
  })

  it('G2-2 discards a redeem that a logout overtook', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const redeem = harness.hold('redeem')

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => redeem.reached, 'the redeem fetch')
    // `evenfire://logout` reaches the same `AppService.logout()` (`main.ts:120-123`).
    await service.logout()
    redeem.release(edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)))
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['replaced'])
    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    expect(harness.tokenWrites).toEqual([])
  })

  it('G2-3 replaces a waiting attempt when another starts', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const first = await startAttempt(harness)
    const second = await startAttempt(harness)
    await harness.drain()

    expect(endStatesOf(harness, first.attemptId)).toEqual(['replaced'])
    expect(service.acceptDesktopLoginLink(codeLink(first.state, envs.A.restBaseUrl))).toBe(false)
    await harness.drain()
    expect(redeemFetches(harness)).toHaveLength(0)

    // The attempt that replaced it redeems its own link.
    expect(service.acceptDesktopLoginLink(codeLink(second.state, envs.A.restBaseUrl))).toBe(true)
    await harness.drain()
    expect(redeemFetches(harness)).toHaveLength(1)
    expect(endStatesOf(harness, second.attemptId)).toEqual(['signed_in'])
  })

  it('G2-9a fails a code from another environment without redeeming', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.B.restBaseUrl))).toBe(true)
    await harness.drain()

    expect(snapshotsOf(harness, attemptId).at(-1)).toEqual({
      attemptId,
      phase: 'ended',
      outcome: 'failed',
      reason: 'different_environment',
    })
    expect(redeemFetches(harness)).toHaveLength(0)
    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
  })

  it('G2-9b spends nothing behind a restore commit', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true, keptToken: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const bind = harness.hold('restoreChatBind')

    const restore = service.getSessionState()
    await until(harness, () => bind.reached, "the restore's chat-store bind")
    // The restore commit holds the owner with the session token set (`appService.ts:2006`) and
    // its generation advance (`:2036`) still ahead.
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: false })
    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await harness.drain({ owner: false })
    bind.release()
    await expect(restore).resolves.toMatchObject({ authenticated: true })
    await harness.drain()

    expect(redeemFetches(harness)).toHaveLength(0)
    expect(endStatesOf(harness, attemptId)).toEqual(['replaced'])
  })

  it('G2-9c sends one redeem on ECONNRESET', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    harness.routes[REDEEM_ROUTE] = () => {
      throw networkFailure()
    }

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    // Real time: the transport's retry would wait 250 ms on the real `setTimeout`, which the
    // browser sign-in clock seam does not replace. `drain` would return before it.
    await vi.waitFor(() => expect(endStatesOf(harness, attemptId)).toEqual(['failed']), {
      timeout: 5_000,
      interval: 10,
    })
    await harness.drain()

    expect(redeemFetches(harness)).toHaveLength(1)
    expect(endStatesOf(harness, attemptId)).toEqual(['failed'])
  })

  it.each(REDEEM_RECORDS.map(row => [row.label, row] as const))(
    "maps the edge's %s through the real transport",
    async (_label, row) => {
      const harness = await createBrowserSignInHarness({ linksAvailable: true })
      const { service, envs } = harness
      const record = row.record()
      harness.routes[REDEEM_ROUTE] = () => edgeResponse(record)
      const transport = vi.spyOn(serviceAuthClient(harness), 'redeemDesktopSignInAt')
      const { attemptId, state } = await startAttempt(harness)

      expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
      await harness.drain()

      // D17 tier 1: the transport handed the edge's answer over as it came.
      expect(transport).toHaveBeenCalledOnce()
      await expect(transport.mock.results[0]?.value).resolves.toStrictEqual(transportAnswer(record))
      expect(snapshotsOf(harness, attemptId).at(-1)).toEqual({
        attemptId,
        phase: 'ended',
        ...row.end,
      })
      const signedIn = row.end.outcome === 'signed_in'
      expect(harness.tokenWrites.map(write => write.value)).toEqual(
        signedIn ? [recordedSessionToken()] : []
      )
      expect(service.getSessionPresence()).toEqual({ hasToken: signedIn, hasMe: signedIn })
    }
  )

  it('sends the redeem to the bound REST URL, never to the link environment', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    // Environment A's endpoint in another spelling: host case and a root dot (A3-30).
    const variant = 'https://EDGE-FIXTURE.example.test./'
    expect(new URL(variant).hostname).toBe(`${new URL(envs.A.restBaseUrl).hostname}.`)

    expect(service.acceptDesktopLoginLink(codeLink(state, variant))).toBe(true)
    await harness.drain()

    expect(redeemFetches(harness).map(record => record.value.url)).toEqual([
      `${envs.A.restBaseUrl}${REDEEM_PATH}`,
    ])
    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
  })

  it('redeems with the verifier whose S256 challenge opened the page', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const page = openedPage(harness, 0)

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
    const body = redeemFetches(harness)[0]?.value.body
    expect(body).toEqual({
      code: recordedCode(),
      codeVerifier: expect.stringMatching(SECRET_SHAPE),
    })
    const { codeVerifier } = body as { codeVerifier: string }
    // RFC 7636 S256, computed here rather than by the code under test.
    expect(createHash('sha256').update(codeVerifier).digest('base64url')).toBe(page?.challenge)
    // D18: neither the code, the verifier nor the state left through a log, a push or a reply.
    const secrets = [recordedCode(), codeVerifier, state]
    expect(
      harness.secretsSeen.filter(text => secrets.some(secret => text.includes(secret)))
    ).toEqual([])
    // The session token left only through the one token-store write.
    const token = recordedSessionToken()
    expect(harness.tokenWrites.map(write => write.value)).toEqual([token])
    expect(harness.secretsSeen.filter(text => text.includes(token))).toEqual([token])
  })

  it('drops an error link for the waiting state while its redeem is held', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const redeem = harness.hold('redeem')

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => redeem.reached, 'the redeem fetch')
    // A3-61: the attempt is `redeeming`, so its state no longer matches at the pre-match.
    expect(
      service.acceptDesktopLoginLink(buildDesktopLoginErrorLink({ state, error: 'failed' }))
    ).toBe(false)
    redeem.release(edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)))
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
  })

  it('keeps a redeeming attempt when its browser open fails afterwards', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const open = harness.hold('open')

    const start = service.startBrowserSignIn()
    await until(harness, () => open.reached, 'the browser open')
    const state = openedPage(harness, 0)?.state ?? ''
    expect(state).toMatch(SECRET_SHAPE)
    const redeem = harness.hold('redeem')
    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => redeem.reached, 'the redeem fetch')
    // The open fails once the attempt is redeeming: only a waiting attempt ends `failed` (A3-66).
    open.release(new Error('fake browser open failure'))
    await expect(start).rejects.toThrow(/^browser_open_failed$/)
    redeem.release(edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)))
    await harness.drain()

    expect(endStatesOf(harness, 1)).toEqual(['signed_in'])
  })

  it('ends failed when install throws after the session is set', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const write = harness.hold('installTokenWrite')

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => write.reached, "the install's token write")
    write.release(new Error('fake keychain write failure'))
    await harness.drain()

    // X1. The install ran as far as the token write.
    expect(harness.tokenWrites.map(entry => entry.value)).toEqual([recordedSessionToken()])
    expect(endStatesOf(harness, attemptId)).toEqual(['failed'])
    // Logged once, with the error class only.
    expect(harness.secretsSeen.filter(text => text.startsWith(LINK_HANDLING_FAILED))).toEqual([
      `${LINK_HANDLING_FAILED} Error`,
    ])
    expect(harness.secretsSeen.filter(text => text.includes('fake keychain write'))).toEqual([])
    // The install op itself ends the attempt, before the chain's last catch reports the error
    // (R-4's catch would end it too, one owner op later).
    const endedAt = harness.secretsSeen.indexOf(
      JSON.stringify({ attemptId, phase: 'ended', outcome: 'failed' })
    )
    expect(endedAt).toBeGreaterThanOrEqual(0)
    expect(endedAt).toBeLessThan(harness.secretsSeen.indexOf(`${LINK_HANDLING_FAILED} Error`))
    // D11: the redeem's count settled on this throw path too. X1 left the session in memory, so
    // setup proceeds once a logout has cleared it.
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
    await service.logout()
    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    await expect(completeSetup(harness)).resolves.toMatchObject({ configured: true })
    expect(setupFetches(harness)).toBe(1)
  })

  it(`fails a 200 whose me has no id, without installing (${SIGNED_IN_WITHOUT_ME_ID})`, async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    harness.routes[REDEEM_ROUTE] = () => edgeResponse(signedInWithoutMeId())
    const { attemptId, state } = await startAttempt(harness)

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await harness.drain()

    expect(redeemFetches(harness)).toHaveLength(1)
    expect(snapshotsOf(harness, attemptId).at(-1)).toEqual({
      attemptId,
      phase: 'ended',
      outcome: 'failed',
    })
    expect(harness.tokenWrites).toEqual([])
    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
  })

  it(`ends an unusable 200 that a logout overtook replaced (${SIGNED_IN_WITHOUT_ME_ID})`, async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const redeem = harness.hold('redeem')

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => redeem.reached, 'the redeem fetch')
    await service.logout()
    redeem.release(edgeResponse(signedInWithoutMeId()))
    await harness.drain()

    // R-4: the install op's current checks come before the unusable answer's `failed`.
    expect(endStatesOf(harness, attemptId)).toEqual(['replaced'])
  })

  it('ends a redeeming attempt failed when its handling throws', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    vi.spyOn(serviceAuthClient(harness), 'redeemDesktopSignInAt').mockRejectedValueOnce(
      new Error('fake redeem failure')
    )

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await harness.drain()

    // R-4: the chain's last catch ends the attempt it left redeeming, then logs the error class.
    expect(snapshotsOf(harness, attemptId).map(snapshot => snapshot.phase)).toEqual([
      'waiting',
      'redeeming',
      'ended',
    ])
    expect(endStatesOf(harness, attemptId)).toEqual(['failed'])
    expect(harness.secretsSeen).toContain(`${LINK_HANDLING_FAILED} Error`)
    expect(harness.secretsSeen.filter(text => text.includes('fake redeem failure'))).toEqual([])
    // D11: the redeem's count settled on this throw path too, so signed-out setup proceeds.
    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    await expect(completeSetup(harness)).resolves.toMatchObject({ configured: true })
    expect(setupFetches(harness)).toBe(1)
  })

  it('ends a waiting attempt failed when its acceptance op throws before the redeem', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    await harness.drain()
    const now = vi.spyOn(harness.clock, 'now')
    // The harness's own spies, which record every console line.
    const consoleSpies = CONSOLE_LEVELS.map(level => vi.spyOn(console, level))
    const callsBefore = consoleSpies.map(spy => spy.mock.calls.length)
    const consoleLinesSince = () =>
      consoleSpies.flatMap((spy, index) =>
        spy.mock.calls.slice(callsBefore[index]).map(args => format(...args))
      )

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    // The pre-match has read the clock. The acceptance op's own deadline check, its next read,
    // throws: the window is raised and the attempt still waits (R-25).
    now.mockImplementationOnce(() => {
      throw new Error('fake clock failure')
    })
    await harness.drain()

    expect(now.mock.results.filter(result => result.type === 'throw')).toHaveLength(1)
    expect(snapshotsOf(harness, attemptId)).toEqual([
      { attemptId, phase: 'waiting' },
      { attemptId, phase: 'ended', outcome: 'failed' },
    ])
    expect(redeemFetches(harness)).toHaveLength(0)
    // One line, with the error class only.
    expect(consoleLinesSince()).toEqual([`${LINK_HANDLING_FAILED} Error`])
    expect(harness.secretsSeen.filter(text => text.includes('fake clock failure'))).toEqual([])
  })

  it('logs and drops a link whose acceptance throws, never throwing to the router', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const link = codeLink(state, envs.A.restBaseUrl)
    const now = vi.spyOn(harness.clock, 'now').mockImplementationOnce(() => {
      throw new Error('fake clock failure')
    })

    let accepted: boolean | undefined
    expect(() => {
      accepted = service.acceptDesktopLoginLink(link)
    }).not.toThrow()
    expect(accepted).toBe(false)
    expect(now).toHaveBeenCalled()
    await harness.drain()
    expect(redeemFetches(harness)).toHaveLength(0)
    // Fixed text and the error class: no link, state or code.
    expect(harness.secretsSeen).toContain(
      '[AppService] Browser sign-in link acceptance failed: Error'
    )
    const secrets = [link, state, recordedCode(), 'fake clock failure']
    expect(
      harness.secretsSeen.filter(text => secrets.some(secret => text.includes(secret)))
    ).toEqual([])

    // The attempt still waits, and the same link is accepted once the clock answers again.
    expect(service.acceptDesktopLoginLink(link)).toBe(true)
    await harness.drain()
    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
  })

  it('drops a link for an unknown state with no log, push or window', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    await harness.drain()
    const requestMainWindow = vi.fn<() => void>()
    const accepted: boolean[] = []
    const handle = createDesktopLoginLinkHandler({
      accept: rawUrl => {
        const result = service.acceptDesktopLoginLink(rawUrl)
        accepted.push(result)
        return result
      },
      requestMainWindow,
    })
    // The harness's own spies, which record every console line.
    const consoleSpies = CONSOLE_LEVELS.map(level => vi.spyOn(console, level))
    const consoleCalls = () => consoleSpies.map(spy => spy.mock.calls.length)
    const callsBefore = consoleCalls()
    const pushesBefore = harness.pushes.length
    const unknownState = createBrowserSignInSecrets().state
    expect(unknownState).not.toBe(state)

    handle(codeLink(unknownState, envs.A.restBaseUrl))
    await harness.drain()

    expect(accepted).toEqual([false])
    expect(consoleCalls()).toEqual(callsBefore)
    expect(harness.pushes).toHaveLength(pushesBefore)
    expect(requestMainWindow).not.toHaveBeenCalled()
    expect(redeemFetches(harness)).toHaveLength(0)

    // The waiting attempt's own link raises the window once and ends it, in one push.
    handle(buildDesktopLoginErrorLink({ state, error: 'cancelled' }))
    await harness.drain()
    expect(accepted).toEqual([false, true])
    expect(requestMainWindow).toHaveBeenCalledOnce()
    expect(harness.pushes.slice(pushesBefore).map(record => record.value)).toEqual([
      { attemptId, phase: 'ended', outcome: 'cancelled' },
    ])
  })

  it('pins that Node fetch sends no Origin or Sec-Fetch-Site on the redeem request', async () => {
    // G-7, a pin and not a G2 test: the edge's redeem has no browser-origin check to pass, and
    // Node's fetch sends neither header. A real server, bound at runtime, sees the request.
    vi.unstubAllGlobals()
    const record = readEdgeRecord(REDEEM_SIGNED_IN)
    const seen: IncomingHttpHeaders[] = []
    const server = createServer((request, response) => {
      seen.push(request.headers)
      request.resume()
      response.writeHead(record.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(record.body))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('expected a loopback server')

      const answer = await new AuthClient().redeemDesktopSignInAt(
        `http://127.0.0.1:${address.port}`,
        { code: recordedCode(), codeVerifier: createBrowserSignInSecrets().verifier }
      )

      expect(answer).toStrictEqual({ status: 200, body: record.body })
      expect(seen).toHaveLength(1)
      expect(seen[0]?.['content-type']).toBe('application/json')
      expect(seen[0]).not.toHaveProperty('origin')
      expect(seen[0]).not.toHaveProperty('sec-fetch-site')
    } finally {
      server.close()
    }
  })
})

/** The legacy profiles' shared host (T0-5): one profile stores it bare, the other with a slash. */
const LEGACY_REST_HOST = 'api-x.example.test'

type LegacyAttempt = Readonly<{
  harness: BrowserSignInHarness
  runtimeConfig: RuntimeConfigModule
  slashId: string
  /** The REST URL the bare profile stores, which the attempt is bound to. */
  boundRestUrl: string
  generation: number
  attemptId: number
  state: string
}>

/**
 * G2-7's setup: the profiles index the pre-`55331a9eb` saver wrote, with its REST-only bare
 * profile active, and a waiting attempt started on it.
 */
async function startOnLegacyBareProfile(): Promise<LegacyAttempt> {
  const harness = await createBrowserSignInHarness({
    legacyDuplicateProfiles: true,
    linksAvailable: true,
  })
  const runtimeConfig = await import('../config.js')
  const [slash, bare] = harness.service
    .getRuntimeConfigState()
    .options.filter(option => new URL(option.externalRestApiBaseUrl).host === LEGACY_REST_HOST)
  if (!slash || !bare) throw new Error('the legacy profiles were not loaded')
  expect(runtimeConfig.getActiveRuntimeConfigOptionId()).toBe(bare.id)
  expect(bare.rpcProxyBaseUrl).toBe('')
  const { attemptId, state } = await startAttempt(harness)
  return {
    harness,
    runtimeConfig,
    slashId: slash.id,
    boundRestUrl: bare.externalRestApiBaseUrl,
    generation: harness.service.getSessionGeneration(),
    attemptId,
    state,
  }
}

/** X5: a signed-out discovery commit that makes the slash profile active with no bump (T0-5). */
async function switchLegacyProfileWithNoBump(legacy: LegacyAttempt): Promise<void> {
  await legacy.harness.service.getDependenciesHealth()
  expect(legacy.runtimeConfig.getActiveRuntimeConfigOptionId()).toBe(legacy.slashId)
  expect(legacy.harness.service.getSessionGeneration()).toBe(legacy.generation)
}

type EnvironmentVariant = readonly [
  accepted: string,
  refused: string,
  acceptedEnvironment: (bound: URL) => string,
  refusedEnvironment: (bound: URL) => string,
]

/**
 * A3-30: a `code` link's environment that differs from the bound REST URL only by a trailing
 * slash, a root dot or host case is the same environment; another scheme, port or path is not.
 * Each row pairs one accepted spelling with one refused one. Every value is built from the bound
 * URL and goes through PR 2's link builder, which takes only `http:` and `https:` (A-8).
 */
const ENVIRONMENT_VARIANTS: ReadonlyArray<EnvironmentVariant> = [
  [
    'a trailing slash',
    'http: against the bound https:',
    bound => `${bound.origin}/`,
    bound => `http://${bound.host}`,
  ],
  [
    'a root dot',
    'another port',
    bound => `${bound.protocol}//${bound.hostname}.`,
    bound => `${bound.protocol}//${bound.hostname}:8443`,
  ],
  [
    'host case',
    'another path',
    bound => `${bound.protocol}//${bound.hostname.toUpperCase()}`,
    bound => `${bound.origin}/other-edge`,
  ],
]

/** Another host whose URL begins with environment A's recorded REST URL. */
const HOST_SUFFIX_LOOK_ALIKE = 'https://edge-fixture.example.test.other.example'

/**
 * C1: other environments whose URL keeps the bound REST URL as a prefix, even once both are
 * canonicalized. A prefix comparison would take each for the bound environment.
 */
const LOOK_ALIKE_ENVIRONMENTS: ReadonlyArray<
  readonly [label: string, environment: (bound: string) => string]
> = [
  ['a host-suffix look-alike', () => HOST_SUFFIX_LOOK_ALIKE],
  ['the bound URL with another path', bound => `${bound}/api/v1`],
  ['the bound URL with another port', bound => `${bound}:4443`],
]

describe('the binding and the deadline at acceptance', () => {
  it('G2-7 fails, without redeeming, when the profile changed with no bump', async () => {
    // Case 1: the profile id changes while the attempt waits.
    const waiting = await startOnLegacyBareProfile()
    await switchLegacyProfileWithNoBump(waiting)
    // Nothing ended the attempt: D6's hook runs only on a generation advance.
    expect(endStatesOf(waiting.harness, waiting.attemptId)).toEqual([])

    expect(
      waiting.harness.service.acceptDesktopLoginLink(codeLink(waiting.state, waiting.boundRestUrl))
    ).toBe(true)
    await waiting.harness.drain()

    expect(snapshotsOf(waiting.harness, waiting.attemptId).at(-1)).toEqual({
      attemptId: waiting.attemptId,
      phase: 'ended',
      outcome: 'failed',
      reason: 'environment_changed',
    })
    expect(redeemFetches(waiting.harness)).toHaveLength(0)

    // Case 2: the profile id changes while the attempt redeems (A3-60). The code is spent; the
    // install op discards the answer.
    await cleanupBrowserSignInHarness()
    const redeeming = await startOnLegacyBareProfile()
    const redeem = redeeming.harness.hold('redeem')
    expect(
      redeeming.harness.service.acceptDesktopLoginLink(
        codeLink(redeeming.state, redeeming.boundRestUrl)
      )
    ).toBe(true)
    await until(redeeming.harness, () => redeem.reached, 'the redeem fetch')
    await switchLegacyProfileWithNoBump(redeeming)
    redeem.release(edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)))
    await redeeming.harness.drain()

    expect(redeemFetches(redeeming.harness).map(record => record.value.url)).toEqual([
      `${redeeming.boundRestUrl}${REDEEM_PATH}`,
    ])
    expect(endStatesOf(redeeming.harness, redeeming.attemptId)).toEqual(['failed'])
    expect(snapshotsOf(redeeming.harness, redeeming.attemptId).at(-1)).toEqual({
      attemptId: redeeming.attemptId,
      phase: 'ended',
      outcome: 'failed',
      reason: 'environment_changed',
    })
    expect(redeeming.harness.service.getSessionPresence()).toEqual({
      hasToken: false,
      hasMe: false,
    })
    expect(redeeming.harness.tokenWrites).toEqual([])
  })

  it('G2-12b stops the deadline at acceptance', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs, clock } = harness
    const { attemptId, state } = await startAttempt(harness)
    const link = codeLink(state, envs.A.restBaseUrl)
    const redeem = harness.hold('redeem')
    // 14:59 on the wall clock and on the timers' schedule: the deadline timer, due at 15:00, is
    // armed and has not fired.
    clock.advance(BROWSER_SIGN_IN_DEADLINE_MS - 1_000, 'timers')
    expect(clock.pendingTimers()).toBe(1)
    expect(endStatesOf(harness, attemptId)).toEqual([])

    expect(service.acceptDesktopLoginLink(link)).toBe(true)
    await until(harness, () => redeem.reached, 'the redeem fetch')
    // D9 clears V16 at acceptance: no deadline timer stays armed while the attempt redeems.
    expect(clock.pendingTimers()).toBe(0)
    // Past 15:00 on both: a deadline timer still armed would fire here.
    clock.advance(2_000, 'timers')
    // The handoff page's second delivery reaches the pre-match, which applies the deadline on
    // the wall clock (D12) to a waiting attempt only; this one redeems.
    expect(service.acceptDesktopLoginLink(link)).toBe(false)
    redeem.release(edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)))
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
    expect(redeemFetches(harness)).toHaveLength(1)
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
  })

  it.each(ENVIRONMENT_VARIANTS)(
    'accepts %s and refuses %s',
    async (_accepted, _refused, acceptedEnvironment, refusedEnvironment) => {
      const harness = await createBrowserSignInHarness({ linksAvailable: true })
      const { service, envs } = harness
      const bound = new URL(envs.A.restBaseUrl)
      // The rows' premise: the bound URL is an `https:` origin, with no port and no path.
      expect(envs.A.restBaseUrl).toBe(`https://${bound.hostname}`)
      const refusedUrl = refusedEnvironment(bound)
      const acceptedUrl = acceptedEnvironment(bound)
      expect([refusedUrl, acceptedUrl]).not.toContain(envs.A.restBaseUrl)

      // The refused spelling first: once signed in, a second start would be refused.
      const refused = await startAttempt(harness)
      expect(service.acceptDesktopLoginLink(codeLink(refused.state, refusedUrl))).toBe(true)
      await harness.drain()
      expect(snapshotsOf(harness, refused.attemptId).at(-1)).toEqual({
        attemptId: refused.attemptId,
        phase: 'ended',
        outcome: 'failed',
        reason: 'different_environment',
      })
      expect(redeemFetches(harness)).toHaveLength(0)

      const accepted = await startAttempt(harness)
      expect(service.acceptDesktopLoginLink(codeLink(accepted.state, acceptedUrl))).toBe(true)
      await harness.drain()
      expect(endStatesOf(harness, accepted.attemptId)).toEqual(['signed_in'])
      expect(redeemFetches(harness).map(record => record.value.url)).toEqual([
        `${envs.A.restBaseUrl}${REDEEM_PATH}`,
      ])
    }
  )

  it.each(LOOK_ALIKE_ENVIRONMENTS)(
    'refuses %s, which begins with the bound URL, without redeeming',
    async (_label, environment) => {
      const harness = await createBrowserSignInHarness({ linksAvailable: true })
      const { service, envs } = harness
      const lookAlike = environment(envs.A.restBaseUrl)
      expect(lookAlike.startsWith(envs.A.restBaseUrl)).toBe(true)
      const { attemptId, state } = await startAttempt(harness)

      expect(service.acceptDesktopLoginLink(codeLink(state, lookAlike))).toBe(true)
      await harness.drain()

      expect(snapshotsOf(harness, attemptId).at(-1)).toEqual({
        attemptId,
        phase: 'ended',
        outcome: 'failed',
        reason: 'different_environment',
      })
      expect(redeemFetches(harness)).toHaveLength(0)
      expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    }
  )

  it('ends timed_out and redeems nothing for a link after the deadline, before any timer or resume', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs, clock } = harness
    const { attemptId, state } = await startAttempt(harness)
    // A sleep the timer did not count: the wall clock passes the deadline, the timer stays
    // armed, and no resume or state read runs.
    clock.advance(BROWSER_SIGN_IN_DEADLINE_MS + 1_000, 'wallOnly')
    expect(clock.pendingTimers()).toBe(1)
    expect(endStatesOf(harness, attemptId)).toEqual([])

    // The pre-match applies the deadline, so the link raises no window.
    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(false)
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['timed_out'])
    expect(redeemFetches(harness)).toHaveLength(0)
    expect(clock.pendingTimers()).toBe(0)
  })

  it('ends timed_out and redeems nothing when the deadline passes before the acceptance op runs', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs, clock } = harness
    const { attemptId, state } = await startAttempt(harness)
    clock.advance(BROWSER_SIGN_IN_DEADLINE_MS - 1_000, 'wallOnly')

    // 14:59: the pre-match matches and queues the acceptance op in the auth owner.
    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    // The op waits for the owner and has not run yet; the wall clock passes 15:00 first.
    clock.advance(2_000, 'wallOnly')
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['timed_out'])
    expect(redeemFetches(harness)).toHaveLength(0)
  })
})

const HUB_SETUP_PATH = HUB_SETUP_ROUTE.replace(/^POST /, '')
const REDEEM_INVALID: EdgeRecordKey = 'POST /api/v1/oidc/desktop-sign-in/redeem invalid'

/** Desktop setup with the hub's answer (E31/E32), as T0-1 sends it. */
function completeSetup(harness: BrowserSignInHarness) {
  return harness.service.completeDesktopSetup(
    'user-d@example.test',
    'fake-setup-authorization-token'
  )
}

function setupFetches(harness: BrowserSignInHarness): number {
  return fetchCount(harness, 'POST', HUB_SETUP_PATH)
}

describe('redeeming: Cancel, a new start and the interactive login count', () => {
  it('G2-10a keeps redeeming when Cancel arrives', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const redeem = harness.hold('redeem')

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => redeem.reached, 'the redeem fetch')
    // D10: the server may already have spent the code, so Cancel leaves the redeem to finish.
    expect(service.cancelBrowserSignIn()).toEqual({ attemptId, phase: 'redeeming' })
    redeem.release(edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)))
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
  })

  it('G2-10b refuses a new start while redeeming', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const redeem = harness.hold('redeem')

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => redeem.reached, 'the redeem fetch')
    const generation = service.getSessionGeneration()
    await expect(service.startBrowserSignIn()).rejects.toThrow(/^browser_sign_in_finishing$/)
    // Refused in op 1, before the bump and before its own methods read.
    expect(methodsFetches(harness)).toHaveLength(1)
    expect(service.getSessionGeneration()).toBe(generation)
    expect(harness.opens).toHaveLength(1)
    redeem.release(edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)))
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
  })

  it('G2-11a lets desktop setup end a waiting attempt', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { attemptId } = await startAttempt(harness)
    await harness.drain()

    // D11: a waiting attempt is not counted, so setup proceeds and its bump replaces it (A3-18).
    await expect(completeSetup(harness)).resolves.toMatchObject({ configured: true })
    await harness.drain()

    expect(setupFetches(harness)).toBe(1)
    expect(endStatesOf(harness, attemptId)).toEqual(['replaced'])
  })

  it('G2-11b refuses desktop setup while redeeming', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const redeem = harness.hold('redeem')

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => redeem.reached, 'the redeem fetch')
    const generation = service.getSessionGeneration()
    // D11: the redeem is counted, so setup is refused before its bump (A3-40).
    await expect(completeSetup(harness)).rejects.toThrow(/^auth_transition_in_progress$/)
    expect(setupFetches(harness)).toBe(0)
    expect(service.getSessionGeneration()).toBe(generation)
    redeem.release(edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)))
    await harness.drain()

    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
  })

  it('G2-11c accepts desktop setup after a failed redeem settles', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    harness.routes[REDEEM_ROUTE] = () => edgeResponse(readEdgeRecord(REDEEM_INVALID))
    const { attemptId, state } = await startAttempt(harness)

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await harness.drain()
    expect(redeemFetches(harness)).toHaveLength(1)
    expect(endStatesOf(harness, attemptId)).toEqual(['failed'])

    // The settle step ran after the install op: the count is back to 0 (A3-51).
    await expect(completeSetup(harness)).resolves.toMatchObject({ configured: true })
    expect(setupFetches(harness)).toBe(1)
  })

  it('after a successful redeem, setup refuses for the session, not the count', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)

    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await harness.drain()
    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])

    // L5: at quiescence, signed in with no login in flight, the count is 0. Setup is refused for
    // the session; a count left above 0 would have refused it first, as in progress.
    await expect(completeSetup(harness)).rejects.toThrow(new RegExp(`^${REFUSED_SIGNED_IN}$`))
    expect(setupFetches(harness)).toBe(0)
  })

  it('settles only a counted redeem: a link that redeems nothing leaves a password login counted', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service } = harness
    // A password login held at its fetch keeps the count at 1, as in T0-2.
    const passwordLoginAnswer = deferred<Response>()
    let passwordLoginReached = false
    harness.routes['POST /api/v1/auth/password-login'] = () => {
      passwordLoginReached = true
      return passwordLoginAnswer.promise
    }
    const login = service.passwordLogin('user-b@example.test', 'fake-password')
    await until(harness, () => passwordLoginReached, 'the password-login fetch')
    const { attemptId, state } = await startAttempt(harness)

    // The attempt ends from an error link: nothing is redeemed, so nothing is counted or settled.
    expect(
      service.acceptDesktopLoginLink(buildDesktopLoginErrorLink({ state, error: 'cancelled' }))
    ).toBe(true)
    await harness.drain()
    expect(endStatesOf(harness, attemptId)).toEqual(['cancelled'])
    expect(redeemFetches(harness)).toHaveLength(0)
    await expect(completeSetup(harness)).rejects.toThrow(/^auth_transition_in_progress$/)
    expect(setupFetches(harness)).toBe(0)

    // Once the password login settles, the count is 0 and setup proceeds.
    passwordLoginAnswer.resolve(
      new Response(JSON.stringify({ error: 'invalid_credentials' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' },
      })
    )
    await expect(login).rejects.toThrow(/httpStatus=401$/)
    await expect(completeSetup(harness)).resolves.toMatchObject({ configured: true })
    expect(setupFetches(harness)).toBe(1)
  })

  it('queues the acceptance op, which counts the redeem, before the link is accepted (A3-33)', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    await harness.drain()

    // Setup queues its first owner op, which reads the count, on the call. Called in the turn
    // that `true` returns in, it finds the redeem counted only if the acceptance op was queued
    // before the return. A restore cannot tell: the op that reads the count is its second,
    // after a discovery check, so an acceptance op queued a turn late would still precede it.
    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await expect(completeSetup(harness)).rejects.toThrow(/^auth_transition_in_progress$/)
    await harness.drain()

    expect(setupFetches(harness)).toBe(0)
    expect(redeemFetches(harness)).toHaveLength(1)
    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
  })

  it('lets the fail-safe of a failed install leave a newer attempt alone', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const first = await startAttempt(harness)
    // The store's `end`, through which the terminal fail-safe ends its attempt (R-25), recording
    // which attempt was current when each call ran.
    const store = (service as unknown as { browserSignIn: BrowserSignInAttempts }).browserSignIn
    const storeEnd = store.end.bind(store)
    const endCalls: Array<{
      id: number
      current: number | null
      phase: string | null
      ended: boolean
    }> = []
    vi.spyOn(store, 'end').mockImplementation((id, end) => {
      const current = store.current()
      const ended = storeEnd(id, end)
      endCalls.push({ id, current: current?.id ?? null, phase: current?.phase ?? null, ended })
      return ended
    })
    // The settle step's discovery commit, held. The count below rests on two call sites of the
    // private `commitPendingRuntimeConfigDiscoveryIfSafe`: logout's (`appService.ts:3239`, in
    // `logout`) makes the first call, and the settle step's (`:2455`, in
    // `settleInteractiveLoginAttempt`) the second. The third, restore's (`:1916`), is not reached:
    // no restore runs here. While the second is held, the settle op keeps the owner, so the new
    // start's op 2 queues ahead of the fail-safe op, which is queued only after the settle.
    const pending = service as unknown as {
      commitPendingRuntimeConfigDiscoveryIfSafe(): Promise<void>
    }
    const commitPending = pending.commitPendingRuntimeConfigDiscoveryIfSafe.bind(service)
    const settleCommit = deferred<void>()
    let commits = 0
    vi.spyOn(pending, 'commitPendingRuntimeConfigDiscoveryIfSafe').mockImplementation(async () => {
      commits += 1
      if (commits === 2) await settleCommit.promise
      return commitPending()
    })
    const write = harness.hold('installTokenWrite')

    expect(service.acceptDesktopLoginLink(codeLink(first.state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => write.reached, "the install's token write")
    // X1 leaves the session in memory, so the new start needs a logout. Both queue behind the
    // install op, ahead of its settle op.
    const logout = service.logout()
    const second = service.startBrowserSignIn()
    write.release(new Error('fake keychain write failure'))
    await until(
      harness,
      () => commits === 2 && methodsFetches(harness).length === 2,
      "the settle step's commit and the new start's methods read"
    )
    await harness.drain({ owner: false })
    expect(endStatesOf(harness, first.attemptId)).toEqual(['failed'])
    settleCommit.resolve()
    await expect(logout).resolves.toEqual(expect.any(Number))
    const { attemptId } = await second
    await harness.drain()

    expect(attemptId).toBe(first.attemptId + 1)
    expect(commits).toBe(2)
    // The positive control: the fail-safe's `end` for the first attempt ran while the newer one
    // was current and waiting, and ended nothing.
    expect(endCalls.filter(call => call.id === first.attemptId)).toEqual([
      { id: first.attemptId, current: first.attemptId, phase: 'redeeming', ended: true },
      { id: first.attemptId, current: attemptId, phase: 'waiting', ended: false },
    ])
    expect(harness.secretsSeen).toContain(`${LINK_HANDLING_FAILED} Error`)
    expect(endStatesOf(harness, first.attemptId)).toEqual(['failed'])
    expect(snapshotsOf(harness, attemptId)).toEqual([{ attemptId, phase: 'waiting' }])
  })
})

const PUSH_FAILED = '[AppService] Browser sign-in state push failed'
const SIXTEEN_MINUTES_MS = 16 * 60 * 1000

/** The recorded 403's end state: `refused`, with the reason the edge recorded (D17). */
function recordedRefusal(): BrowserSignInEnd {
  const { reason } = readEdgeRecord(REDEEM_REFUSED).body as { reason: 'account_disabled' }
  return { outcome: 'refused', reason }
}

describe('browser sign-in state reads, acknowledgement and the resume check', () => {
  it('G2-6b signs out even when the push target throws', async () => {
    const failure = new Error('fake push target failure')
    const pushTarget = vi.fn<(snapshot: BrowserSignInSnapshot) => void>()
    const harness = await createBrowserSignInHarness({
      linksAvailable: true,
      onBrowserSignInChanged: pushTarget,
    })
    const { service } = harness
    const { attemptId } = await startAttempt(harness)
    await harness.drain()
    expect(pushTarget.mock.calls).toEqual([[{ attemptId, phase: 'waiting' }]])
    // The harness's spy on `console.warn`: its calls from here on are logout's and its push's.
    const warn = vi.spyOn(console, 'warn')
    const warnedBefore = warn.mock.calls.length
    const before = service.getSessionGeneration()
    const logged = harness.bumpLog.length
    // From here on the push target throws. Logout's first advance, the first statement of its
    // owner op, ends the waiting attempt `replaced` (D6).
    pushTarget.mockImplementation(() => {
      throw failure
    })

    await expect(service.logout()).resolves.toBe(before + 2)
    await harness.drain()

    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    expect(harness.bumpLog.slice(logged).map(record => record.value)).toEqual([
      before + 1,
      before + 2,
    ])
    // The end reached the push target, which threw; the snapshot stays for the next read (D13).
    const replaced = { attemptId, phase: 'ended', outcome: 'replaced' }
    expect(pushTarget.mock.calls.slice(1)).toEqual([[replaced]])
    expect(pushTarget.mock.results.at(-1)?.type).toBe('throw')
    expect(service.getBrowserSignInState()).toEqual(replaced)
    expect(warn.mock.calls.slice(warnedBefore)).toEqual([[PUSH_FAILED, failure]])
  })

  it('G2-12a ends an overdue attempt on resume, and pushes it', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, clock } = harness
    const { attemptId } = await startAttempt(harness)
    await harness.drain()
    const pushesBefore = harness.pushes.length
    // A sleep the deadline timer did not count: the wall clock is 16 minutes on, the timer is
    // still armed, and nothing has read the state.
    clock.advance(SIXTEEN_MINUTES_MS, 'wallOnly')
    expect(clock.pendingTimers()).toBe(1)

    service.checkBrowserSignInDeadline()
    // The push is deferred (D6).
    expect(harness.pushes).toHaveLength(pushesBefore)
    await harness.drain()

    expect(harness.pushes.slice(pushesBefore).map(record => record.value)).toEqual([
      { attemptId, phase: 'ended', outcome: 'timed_out' },
    ])
    expect(clock.pendingTimers()).toBe(0)
  })

  it('G2-13a keeps the outcome until it is acknowledged', async () => {
    const harness = await createBrowserSignInHarness({
      linksAvailable: true,
      withoutPushTarget: true,
    })
    const { service, envs } = harness
    harness.routes[REDEEM_ROUTE] = () => edgeResponse(readEdgeRecord(REDEEM_REFUSED))
    const { attemptId, state } = await startAttempt(harness)

    // No window takes the end (A3-52): the redeem is refused while nothing is pushed.
    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await harness.drain()
    expect(redeemFetches(harness)).toHaveLength(1)

    // Reading does not acknowledge: every read returns the outcome until then (D13).
    const outcome = { attemptId, phase: 'ended', ...recordedRefusal() }
    expect(service.getBrowserSignInState()).toEqual(outcome)
    expect(service.getBrowserSignInState()).toEqual(outcome)

    expect(service.acknowledgeBrowserSignInResult(attemptId)).toEqual({ attemptId, phase: 'idle' })
    expect(service.getBrowserSignInState()).toEqual({ attemptId, phase: 'idle' })
  })

  it('G2-13b ignores an acknowledgement for an older attempt', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, clock } = harness
    const first = await startAttempt(harness)
    expect(service.cancelBrowserSignIn()).toEqual({
      attemptId: first.attemptId,
      phase: 'ended',
      outcome: 'cancelled',
    })
    const second = await startAttempt(harness)
    // The second attempt's deadline timer ends it.
    clock.advance(BROWSER_SIGN_IN_DEADLINE_MS, 'timers')
    await harness.drain()
    const secondOutcome = { attemptId: second.attemptId, phase: 'ended', outcome: 'timed_out' }
    const pushesBefore = harness.pushes.length

    // The first outcome's acknowledgement arrives after the second attempt has ended (A3-54).
    expect(service.acknowledgeBrowserSignInResult(first.attemptId)).toEqual(secondOutcome)
    expect(service.getBrowserSignInState()).toEqual(secondOutcome)
    await harness.drain()
    expect(harness.pushes).toHaveLength(pushesBefore)

    // The second attempt's own acknowledgement clears it, with one push.
    const idle = { attemptId: second.attemptId, phase: 'idle' }
    expect(service.acknowledgeBrowserSignInResult(second.attemptId)).toEqual(idle)
    expect(service.getBrowserSignInState()).toEqual(idle)
    await harness.drain()
    expect(harness.pushes.slice(pushesBefore).map(record => record.value)).toEqual([idle])
  })

  it('ends an overdue attempt at a state read', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, clock } = harness
    const { attemptId } = await startAttempt(harness)
    await harness.drain()
    const generation = service.getSessionGeneration()
    const logged = harness.bumpLog.length
    const pushesBefore = harness.pushes.length

    // A3-67: before the deadline a read changes nothing.
    clock.advance(BROWSER_SIGN_IN_DEADLINE_MS - 1_000, 'wallOnly')
    expect(service.getBrowserSignInState()).toEqual({ attemptId, phase: 'waiting' })
    // At the deadline on the wall clock, with the timer not yet fired, the read ends it.
    clock.advance(1_000, 'wallOnly')
    expect(clock.pendingTimers()).toBe(1)
    const timedOut = { attemptId, phase: 'ended', outcome: 'timed_out' }
    expect(service.getBrowserSignInState()).toEqual(timedOut)
    await harness.drain()

    expect(harness.pushes.slice(pushesBefore).map(record => record.value)).toEqual([timedOut])
    expect(clock.pendingTimers()).toBe(0)
    // Neither the reads nor the acknowledgement touch the generation or the session.
    expect(service.acknowledgeBrowserSignInResult(attemptId)).toEqual({ attemptId, phase: 'idle' })
    expect(service.getSessionGeneration()).toBe(generation)
    expect(harness.bumpLog).toHaveLength(logged)
    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
  })
})
