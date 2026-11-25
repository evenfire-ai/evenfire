import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type BrowserSignInHarness,
  cleanupBrowserSignInHarness,
  createBrowserSignInHarness,
  harnessDriverUsers,
} from '../../testSupport/browserSignInHarness.js'

// Bodies outside the feature contract (G-5) come from the harness. The discovery answer is the
// shape of the edge's own route, `external-rest-api/src/routes/desktop.ts:11-17`, with
// `externalRestApiBaseUrl` set to the profile's canonical endpoint.

afterEach(cleanupBrowserSignInHarness)

const UNTIL_TURN_LIMIT = 200

async function until(harness: BrowserSignInHarness, reached: () => boolean, what: string) {
  for (let turn = 0; !reached(); turn += 1) {
    if (turn >= UNTIL_TURN_LIMIT) throw new Error(`${what} was not reached`)
    await harness.drain()
  }
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
  /** `getSessionState`'s last restore attempt was on A's key, so its retry gate holds A shut. */
  lastRestoreOnA: boolean
}
type BumpReal = { harness: BrowserSignInHarness; scheduler: fc.Scheduler }
type Expectation = { bump: boolean; rejects?: string }
type Outcome = { ok: true } | { ok: false; message: string }
type BumpEvent = {
  id: string
  label: string
  check(model: BumpModel): boolean
  expect(model: BumpModel): Expectation
  act(real: BumpReal, model: Readonly<BumpModel>): Promise<unknown>
  /** Moves the model; it runs once the real outcome matched the expectation. */
  next(model: BumpModel): void
}

const ENV_D_REST = 'https://api-d.example.test'
const HUB_SETUP_ROUTE = 'POST /api/v1/invitations-flow/desktop-setup/complete'
const REFUSED_SIGNED_IN = 'desktop_setup_requires_signout'
const CONDITIONAL_EVENTS = ['E15', 'E16', 'E23', 'E29', 'E31/E32']
const bumpOutcomesSeen = new Map<string, Set<boolean>>()

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

/** A boundary change away from A clears A's saved token (`appService.ts:2189`). */
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
    expect: model => ({
      bump: !model.signedIn && model.active === 'A' && model.storedA && !model.lastRestoreOnA,
    }),
    act: real => real.harness.service.getSessionState(),
    next: model => {
      if (model.signedIn) return
      const restored = model.active === 'A' && model.storedA && !model.lastRestoreOnA
      model.lastRestoreOnA = model.active === 'A'
      if (restored) model.signedIn = true
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
    const outcome = await settle(real, () => this.event.act(real, model))
    expect(outcome).toEqual(
      expected.rejects ? { ok: false, message: expected.rejects } : { ok: true }
    )
    const after = service.getSessionGeneration()
    expect(after).toBeGreaterThanOrEqual(before)
    expect(after > before).toBe(expected.bump)
    this.event.next(model)
    expect(service.getCachedUserId() !== null).toBe(model.signedIn)
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

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.boolean(),
        commands,
        async (scheduler, keptToken, generated) => {
          const harness = await createBrowserSignInHarness({ scheduler, keptToken })
          try {
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
              lastRestoreOnA: false,
            }
            await fc.asyncModelRun(() => ({ model, real: { harness, scheduler } }), generated)
          } finally {
            await cleanupBrowserSignInHarness()
          }
        }
      ),
      { numRuns: 24, seed: 24112026 }
    )

    // Every reachable event ran, and each conditional one was seen both bumping and not.
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
