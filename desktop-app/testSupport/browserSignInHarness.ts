import { vi } from 'vitest'
import type { Scheduler } from 'fast-check'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import type { AppService } from '../src/appService.js'
import type { BrowserSignInClock, BrowserSignInTimerHandle } from '../src/browserSignIn.js'
import type { TokenStore } from '../src/tokenStore.js'
import type { SessionMe } from '../src/types.js'
import { testSessionMe, testTeamSwitchResult } from './authTestFixtures.js'
import { type EdgeRecordKey, readEdgeRecord } from './edgeContractRecords.js'

/**
 * The real `AppService` for the browser sign-in model (state model §7.3): a temp `userData`
 * with stored profiles A and B and a REST-only profile C, `electron` mocked, the token store a
 * fake passed through `AppServiceOptions.tokenStore`, `bindChatStoreForUser` mocked, and HTTP
 * mocked at `fetch` only, so the real `AuthClient` and `requestJson` run. The service gets the
 * test-only generation observer (feeding `bumpLog`), a `FakeBrowserSignInClock` and the links
 * option through its constructor, as `main.ts` never does.
 *
 * Not wired yet, and so absent rather than silently empty: the snapshot pushes (Task 6).
 */

/** One counter is shared by every recorder, so records of different kinds can be ordered. */
export type SeqRecord<T> = Readonly<{ seq: number; value: T }>

type FakeTimer = { id: number; dueMs: number; callback: () => void }

/**
 * The browser sign-in clock for tests (R-2). The wall clock and the timers' schedule are kept
 * apart, as in the main process: the deadline is checked on the wall clock, and its Node timer
 * keeps its own schedule (D12).
 * - `advance(ms, 'wallOnly')` moves the wall clock only, as a clock change or a sleep the timer
 *   did not count would; no timer fires. `ms` may be negative (the clock set back).
 * - `advance(ms, 'timers')` moves the wall clock and the timers' schedule together and fires
 *   each timer that falls due, in due order, with the wall clock at its due time.
 */
export class FakeBrowserSignInClock implements BrowserSignInClock {
  private wallMs: number
  private scheduleMs = 0
  private lastTimerId = 0
  private readonly timers = new Map<number, FakeTimer>()

  constructor(startMs: number = Date.now()) {
    this.wallMs = startMs
  }

  now(): number {
    return this.wallMs
  }

  setTimer(callback: () => void, ms: number): BrowserSignInTimerHandle {
    this.lastTimerId += 1
    const id = this.lastTimerId
    this.timers.set(id, { id, dueMs: this.scheduleMs + Math.max(0, ms), callback })
    // The store only hands the handle back to `clearTimer`; a number stands in for Node's.
    return id as unknown as BrowserSignInTimerHandle
  }

  clearTimer(handle: BrowserSignInTimerHandle): void {
    this.timers.delete(handle as unknown as number)
  }

  /** Timers set and neither fired nor cleared. */
  pendingTimers(): number {
    return this.timers.size
  }

  advance(ms: number, via: 'wallOnly' | 'timers'): void {
    if (!Number.isFinite(ms)) throw new Error(`advance: ${ms} is not a finite number of ms`)
    if (via === 'wallOnly') {
      this.wallMs += ms
      return
    }
    if (ms < 0) throw new Error('advance: the timers schedule cannot go back')
    const targetMs = this.scheduleMs + ms
    for (let due = this.nextDue(targetMs); due; due = this.nextDue(targetMs)) {
      this.wallMs += due.dueMs - this.scheduleMs
      this.scheduleMs = due.dueMs
      this.timers.delete(due.id)
      due.callback()
    }
    this.wallMs += targetMs - this.scheduleMs
    this.scheduleMs = targetMs
  }

  private nextDue(targetMs: number): FakeTimer | undefined {
    let next: FakeTimer | undefined
    for (const timer of this.timers.values()) {
      if (timer.dueMs <= targetMs && (!next || timer.dueMs < next.dueMs)) next = timer
    }
    return next
  }
}

/**
 * Named by call site (N-5). Each hold applies to the next call that reaches its point.
 * - `methods`: start's methods fetch.
 * - `open`: `shell.openExternal`.
 * - `redeem`: the redeem fetch.
 * - `restoreTokenRead`: restore's `tokenStore.getSessionToken` (`appService.ts:1907`).
 * - `restoreChatBind`: restore's `bindChatStoreForUser` (`appService.ts:1979`).
 * - `installChatBind`: install's `bindChatStoreForUser`, via `bindCurrentChatStore`
 *   (`appService.ts:2097`).
 * - `installTokenWrite`: install's `tokenStore.setSessionToken` (`appService.ts:2103`).
 *
 * The two chat-store holds match by user id, not by call site. `restoreChatBind` takes the next
 * bind of the restore driver's user, and `installChatBind` the next bind of the redeem answer's
 * user, wherever it comes from. So any later bind of that user consumes a pending hold: the
 * team-switch `/me` refresh in `commitSessionToken` (`appService.ts:1311`), the team-scope
 * commit after discovery in `runWithTeamContextInTeamQueue` (`:1460`), the rebind after a
 * failed hop restore (`:1563`) and `refreshAccessCatalog` (`:4275`). Set a chat-store hold only
 * when the bind it names is the next bind of that user.
 */
export type HoldPoint =
  | 'methods'
  | 'open'
  | 'redeem'
  | 'restoreTokenRead'
  | 'restoreChatBind'
  | 'installChatBind'
  | 'installTokenWrite'

export type HarnessRequest = Readonly<{
  url: string
  method: string
  path: string
  body: unknown
  headers: Readonly<Record<string, string>>
}>

/** Answers one request. The key is `<METHOD> <pathname>`, whatever the host. */
export type HarnessRouteAnswer = (request: HarnessRequest) => Response | Promise<Response>
export type HarnessRoutes = Record<string, HarnessRouteAnswer>

/**
 * A hold delays the held call's effect, not only its answer: a held token write has not saved
 * the token, and a held bind has not bound, until `release`. The scheduler, by contrast, runs a
 * call's effect at once and delays only when its caller sees the answer (`deliver`).
 */
export type HarnessHold = {
  /**
   * Lets the held call go on. A `Response` answers a held fetch; an `Error` rejects the held
   * call; nothing runs the call as it would have run. A released call does not pass through the
   * scheduler: the test chose the moment.
   */
  release(answer?: Response | Error): void
  readonly reached: boolean
}

export type HarnessDrainOptions = Readonly<{
  /**
   * Also wait for the auth owner queue to settle (`whenAuthCommitsSettled`). Defaults to true.
   * Pass false while a hold sits under an owner op (`restoreTokenRead`, `restoreChatBind`,
   * `installChatBind`, `installTokenWrite`): that queue cannot settle until the release.
   */
  owner?: boolean
}>

export type HarnessEnvironment = Readonly<{ optionId: string; restBaseUrl: string }>

export type BrowserSignInHarness = {
  service: AppService
  /** A and B have an RPC URL; C is REST-only, so discovery runs on it. */
  envs: Readonly<Record<'A' | 'B' | 'C', HarnessEnvironment>>
  fetches: SeqRecord<{
    url: string
    method: string
    body: unknown
    headers: Record<string, string>
  }>[]
  tokenWrites: SeqRecord<string>[]
  /** The environment key of each `tokenStore.getSessionToken` call, recorded when it is made. */
  tokenReads: SeqRecord<string>[]
  /** URLs passed to `shell.openExternal`. */
  opens: SeqRecord<string>[]
  /** Each value the generation observer was given, in order (state model §7.3, seam 1). */
  bumpLog: SeqRecord<number>[]
  /** The service's browser sign-in clock. */
  clock: FakeBrowserSignInClock
  /**
   * Everything the harness can see leave the service: replies of the service's methods,
   * `console.*` lines and token-store writes (and, from Task 6, the pushes). The router queue
   * is private to the router, and the harness builds only `AppService`, so it is not here.
   */
  secretsSeen: string[]
  /** `<METHOD> <pathname>` of each request that had no route. Cleanup fails while it is non-empty. */
  unrouted: string[]
  routes: HarnessRoutes
  hold(point: HoldPoint): HarnessHold
  /**
   * Waits until 3 `setImmediate` turns in a row find the scheduler idle and, unless
   * `{ owner: false }`, the auth owner queue settled.
   */
  drain(options?: HarnessDrainOptions): Promise<void>
}

export type BrowserSignInHarnessOptions = Readonly<{
  scheduler?: Scheduler
  /** Loads the profiles the pre-`55331a9eb` saver wrote (G2-7) and makes its active one active. */
  legacyDuplicateProfiles?: boolean
  /** Keeps a saved session token for the active environment, so a restore has one to read. */
  keptToken?: boolean
  /** Passed as `browserSignInLinksAvailable`. Defaults to false, as the service's does. */
  linksAvailable?: boolean
  /**
   * Called with each generation value after `bumpLog` records it. A throw from it reaches the
   * service's guard around its observer.
   */
  onSessionGenerationAdvanced?: (value: number) => void
}>

/**
 * Answers outside the feature contract (G-5). Their bodies reuse the existing suites':
 * `authTestFixtures.ts` (`testSessionMe`, `testTeamSwitchResult`), the users of
 * `appService.setupRestoreRace.test.ts`, and the bare 401 of
 * `appService.devEdgeCompatibility.test.ts`. The password and Google login answers are
 * `LoginResult`, `{ token, me }` (`src/types.ts:82-85`), which `AuthClient.passwordLogin` and
 * `AuthClient.googleLogin` return as they are. The `/health` answer is `{ status: 'ok' }`, as
 * `appService.discoveryLifecycle.test.ts:309` serves it. Each driver has its own user, so the
 * chat-store binder can tell the call sites apart by the user id it binds (N-5).
 */
export const harnessDriverUsers = Object.freeze({
  /** The user of the kept token's `/me`; the restore binds it. */
  restore: testSessionMe(),
  password: testSessionMe({
    id: 'user-b',
    email: 'user-b@example.test',
    name: 'User B',
    teamId: 'team-b',
    teamName: 'Team B',
  }),
  google: testSessionMe({
    id: 'user-c',
    email: 'user-c@example.test',
    name: 'User C',
    teamId: 'team-c',
    teamName: 'Team C',
  }),
})

const KEPT_SESSION_TOKEN = 'fake-kept-session-token'
const REST_B = 'https://api-b.example.test'
const REST_C = 'https://api-c.example.test'
const HUB_BASE_URL = 'https://hub.example.test'
// What the edge's `GET /api/v1/desktop/environment` serves (`external-rest-api/src/routes/
// desktop.ts:11-17`): its public URL, which is the profile's canonical endpoint when it is
// configured right, its RPC URL, and `desktopAppName`, whose default is 'Evenfire'.
const DISCOVERED_RPC_BASE_URL = 'https://rpc-discovered.example.test'
const DISCOVERED_APP_NAME = 'Evenfire'
const SETUP_REST_BASE_URL = 'https://api-setup.example.test'

const LEGACY_PROFILES_PATH = fileURLToPath(
  new URL('./fixtures/legacy-duplicate-profiles/runtime-configs', import.meta.url)
)
const FETCH_HOLD_POINTS: Readonly<Record<string, HoldPoint>> = {
  'GET /api/v1/auth/methods': 'methods',
  'POST /api/v1/oidc/desktop-sign-in/redeem': 'redeem',
}
const SWITCH_TEAM_ROUTE = 'POST /api/v1/me/switch-team'
const DRAIN_QUIET_TURNS = 3
const DRAIN_TURN_LIMIT = 1000
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const
const SAVED_ENVIRONMENT = [
  'CLERUM_DESKTOP_CONFIG_PATH',
  'EXTERNAL_REST_API_BASE_URL',
  'RPC_PROXY_BASE_URL',
  'PROFILE_UI_BASE_URL',
  'EVENFIRE_ONBOARDING_PREVIEW',
  'MEMBER_REGISTRATION_SERVICE_BASE_URL',
] as const

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

type PendingHold = {
  reached: boolean
  released: boolean
  answer: Deferred<Response | Error | undefined>
}

type ActiveHarness = {
  userDataDir: string
  savedEnvironment: Partial<Record<(typeof SAVED_ENVIRONMENT)[number], string>>
  restoreConsole: () => void
  /** Puts back the `fetch` the harness found, so a stub the calling test made survives. */
  restoreFetch: () => void
  unrouted: string[]
}

const activeHarnesses: ActiveHarness[] = []

/**
 * A recorded body, read through `edgeContractRecords.ts`, which owns every read of PR 1's edge
 * records. The harness reads the two values it needs from it, so it never types a recorded
 * value by hand.
 */
function edgeRecordBody(key: EdgeRecordKey): Record<string, unknown> {
  const { body } = readEdgeRecord(key)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`edge.json has no body for the record "${key}"`)
  }
  return body as Record<string, unknown>
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`edge.json: ${what} is not a string`)
  return value
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Server Answer',
    headers: { 'content-type': 'application/json' },
  })
}

function bearerToken(request: HarnessRequest): string {
  return (request.headers.authorization ?? '').replace(/^Bearer /, '')
}

function requestHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value
  })
  return headers
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') return init?.body ?? undefined
  try {
    return JSON.parse(init.body)
  } catch {
    // A body that is not JSON is recorded as the text it is.
    return init.body
  }
}

function replyText(reply: unknown): string | null {
  if (reply === undefined) return null
  if (typeof reply === 'string') return reply
  try {
    return JSON.stringify(reply) ?? String(reply)
  } catch {
    // A reply JSON cannot serialize is scanned as String() gives it: the scan reads text.
    return String(reply)
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export async function createBrowserSignInHarness(
  options: BrowserSignInHarnessOptions = {}
): Promise<BrowserSignInHarness> {
  const scheduler = options.scheduler
  const codeIssued = edgeRecordBody('POST /api/v1/oidc/profile-flow/complete desktop-code-issued')
  const signedIn = edgeRecordBody('POST /api/v1/oidc/desktop-sign-in/redeem signed-in')
  const restA = requireString(codeIssued.environment, 'desktop-code-issued body.environment')
  const redeemUserId = requireString(
    (signedIn.me as { id?: unknown } | undefined)?.id,
    'redeem signed-in body.me.id'
  )

  // P4: the binder tells its call sites apart by user id, so every id it binds differs.
  const binderUserIds = [
    harnessDriverUsers.restore.id,
    redeemUserId,
    harnessDriverUsers.password.id,
    harnessDriverUsers.google.id,
  ]
  if (new Set(binderUserIds).size !== binderUserIds.length) {
    throw new Error(`the binder's user ids are not distinct: ${binderUserIds.join(', ')}`)
  }

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-browser-sign-in-'))
  const savedEnvironment: ActiveHarness['savedEnvironment'] = {}
  for (const name of SAVED_ENVIRONMENT) {
    savedEnvironment[name] = process.env[name]
    delete process.env[name]
  }
  process.env.MEMBER_REGISTRATION_SERVICE_BASE_URL = HUB_BASE_URL

  let seq = 0
  const nextSeq = () => ++seq
  const fetches: BrowserSignInHarness['fetches'] = []
  const tokenWrites: SeqRecord<string>[] = []
  const tokenReads: SeqRecord<string>[] = []
  const opens: SeqRecord<string>[] = []
  const bumpLog: SeqRecord<number>[] = []
  const clock = new FakeBrowserSignInClock()
  const secretsSeen: string[] = []
  const unrouted: string[] = []
  const holds = new Map<HoldPoint, PendingHold[]>()
  const savedTokens = new Map<string, string>()
  const sessionsByToken = new Map<string, SessionMe>()
  const switchTokens = new Set<string>()
  const issued = { password: 0, google: 0, switch: 0 }

  const consoleSpies = CONSOLE_LEVELS.map(level => {
    const original = console[level].bind(console)
    return vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      secretsSeen.push(format(...args))
      original(...args)
    })
  })
  const foundFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const active: ActiveHarness = {
    userDataDir,
    savedEnvironment,
    restoreConsole: () => consoleSpies.forEach(spy => spy.mockRestore()),
    restoreFetch: () => {
      if (foundFetch) Object.defineProperty(globalThis, 'fetch', foundFetch)
      else Reflect.deleteProperty(globalThis, 'fetch')
    },
    unrouted,
  }
  activeHarnesses.push(active)

  /**
   * Resolves through the scheduler when there is one. A pending answer is scheduled once it
   * exists. `produce` runs at once, so the call's effect (a token saved, a route answered) has
   * already happened when the scheduler runs: it delays only the delivery of the answer. A hold
   * (`passThrough`) delays the effect itself.
   */
  const deliver = <T>(label: string, produce: () => T | Promise<T>): Promise<T> => {
    const value = Promise.resolve().then(produce)
    if (!scheduler) return value
    const settled = value.then(
      result => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error })
    )
    return settled
      .then(outcome => scheduler.schedule(Promise.resolve(outcome), label))
      .then(outcome => {
        if (outcome.ok) return outcome.result
        throw outcome.error
      })
  }

  const passThrough = async <T>(
    point: HoldPoint | null,
    label: string,
    perform: (held: Response | undefined) => T | Promise<T>
  ): Promise<T> => {
    const pending = point ? holds.get(point)?.shift() : undefined
    if (!pending) return deliver(label, () => perform(undefined))
    pending.reached = true
    const answer = await pending.answer.promise
    if (answer instanceof Error) throw answer
    return perform(answer)
  }

  const refuseResponse = (point: string) => (held: Response | undefined) => {
    if (held) throw new Error(`a Response answers only a fetch hold, not ${point}`)
  }

  const issueToken = (kind: keyof typeof issued) => {
    issued[kind] += 1
    return `fake-${kind}-session-token-${issued[kind]}`
  }

  const routes: HarnessRoutes = {
    'POST /api/v1/auth/password-login': () =>
      json(200, { token: issueToken('password'), me: harnessDriverUsers.password }),
    'POST /api/v1/auth/google': () =>
      json(200, { token: issueToken('google'), me: harnessDriverUsers.google }),
    'GET /api/v1/me': request => {
      const me = sessionsByToken.get(bearerToken(request))
      return me ? json(200, me) : json(401, { error: 'Unauthorized' })
    },
    [SWITCH_TEAM_ROUTE]: request => {
      const me = sessionsByToken.get(bearerToken(request))
      if (!me) return json(401, { error: 'Unauthorized' })
      const teamId = String((request.body as { teamId?: unknown } | undefined)?.teamId ?? '')
      const token = issueToken('switch')
      sessionsByToken.set(token, { ...me, teamId, teamName: teamId })
      return json(200, testTeamSwitchResult(teamId, token))
    },
    'GET /api/v1/desktop/environment': request =>
      json(200, {
        appName: DISCOVERED_APP_NAME,
        externalRestApiBaseUrl: new URL(request.url).origin,
        rpcProxyBaseUrl: DISCOVERED_RPC_BASE_URL,
      }),
    'GET /health': () => json(200, { status: 'ok' }),
    // The hub's answer, as `appService.setupRestoreRace.test.ts` builds it.
    'POST /api/v1/invitations-flow/desktop-setup/complete': request =>
      json(200, {
        valid: true,
        email: String((request.body as { email?: unknown } | undefined)?.email ?? ''),
        externalRestApiBaseUrl: SETUP_REST_BASE_URL,
        rpcProxyBaseUrl: '',
        appName: 'Environment Setup',
      }),
  }

  /** Learns the sessions an answer issues, so `/me` and the token store can follow them. */
  const observeAnswer = async (key: string, answer: Response): Promise<Response> => {
    if (!answer.ok) return answer
    let body: unknown
    try {
      body = JSON.parse(await answer.clone().text())
    } catch {
      // Only JSON answers issue sessions; any other answer is returned untouched.
      return answer
    }
    const record = body as { token?: unknown; me?: { id?: unknown } } | null
    if (typeof record?.token !== 'string') return answer
    if (key === SWITCH_TEAM_ROUTE) switchTokens.add(record.token)
    if (record.me && typeof record.me.id === 'string') {
      sessionsByToken.set(record.token, record.me as SessionMe)
    }
    return answer
  }

  const harnessFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = requestHeaders(init)
    const body = requestBody(init)
    const request: HarnessRequest = { url, method, path: new URL(url).pathname, body, headers }
    fetches.push({ seq: nextSeq(), value: { url, method, body, headers } })
    const key = `${method} ${request.path}`
    return passThrough(FETCH_HOLD_POINTS[key] ?? null, `fetch ${key}`, async held => {
      if (held) return observeAnswer(key, held)
      const route = routes[key]
      if (!route) {
        unrouted.push(key)
        throw new Error(`browserSignInHarness: no route for ${key}`)
      }
      return observeAnswer(key, await route(request))
    })
  }
  // Not `vi.stubGlobal`: cleanup puts back only this stub (`restoreFetch`), where
  // `vi.unstubAllGlobals()` would also undo the calling test's own stubs.
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: harnessFetch,
  })

  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => (name === 'appData' ? path.dirname(userDataDir) : userDataDir),
      isPackaged: false,
      isReady: () => true,
      setName: () => undefined,
      setPath: () => undefined,
    },
    shell: {
      openExternal: (url: string) => {
        opens.push({ seq: nextSeq(), value: url })
        return passThrough('open', 'shell.openExternal', refuseResponse('open'))
      },
    },
  }))
  vi.doMock('../src/chatStoreBinding.js', () => ({
    bindChatStoreForUser: (userId: string) => {
      const point: HoldPoint | null =
        userId === harnessDriverUsers.restore.id
          ? 'restoreChatBind'
          : userId === redeemUserId
            ? 'installChatBind'
            : null
      return passThrough(point, 'bindChatStoreForUser', refuseResponse('bindChatStoreForUser'))
    },
    unbindChatStore: () => undefined,
    __setChatStoreBaseDirForTests: () => undefined,
  }))

  if (options.legacyDuplicateProfiles) {
    await fs.cp(LEGACY_PROFILES_PATH, path.join(userDataDir, 'runtime-configs'), {
      recursive: true,
    })
  }

  const [{ AppService: AppServiceClass }, runtimeConfig] = await Promise.all([
    import('../src/appService.js'),
    import('../src/config.js'),
  ])
  const optionIdFor = (restBaseUrl: string) => {
    const option = runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(candidate => candidate.externalRestApiBaseUrl === restBaseUrl)
    if (!option) throw new Error(`the harness profile for ${restBaseUrl} was not created`)
    return option.id
  }
  const profiles: Array<[name: 'A' | 'B' | 'C', rest: string, rpc: string]> = [
    ['A', restA, 'https://rpc-a.example.test'],
    ['B', REST_B, 'https://rpc-b.example.test'],
    ['C', REST_C, ''],
  ]
  const envs = {} as Record<'A' | 'B' | 'C', HarnessEnvironment>
  for (const [name, restBaseUrl, rpcProxyBaseUrl] of profiles) {
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restBaseUrl,
      rpcProxyBaseUrl,
      appName: `Environment ${name}`,
    })
    envs[name] = Object.freeze({ optionId: optionIdFor(restBaseUrl), restBaseUrl })
  }
  let activeOptionId = envs.A.optionId
  if (options.legacyDuplicateProfiles) {
    const index = JSON.parse(
      await fs.readFile(path.join(LEGACY_PROFILES_PATH, 'index.json'), 'utf8')
    ) as { activeProfileId?: unknown }
    activeOptionId = requireString(index.activeProfileId, 'legacy index activeProfileId')
  }
  await runtimeConfig.selectDesktopRuntimeConfigOption(activeOptionId)
  if (options.keptToken) {
    savedTokens.set(runtimeConfig.getActiveEnvKey(), KEPT_SESSION_TOKEN)
    sessionsByToken.set(KEPT_SESSION_TOKEN, harnessDriverUsers.restore)
  }

  const tokenStore = {
    getSessionToken: (envKey: string, readOptions: { legacyEnvKeys?: readonly string[] } = {}) => {
      tokenReads.push({ seq: nextSeq(), value: envKey })
      return passThrough('restoreTokenRead', 'tokenStore.getSessionToken', held => {
        refuseResponse('restoreTokenRead')(held)
        for (const key of [envKey, ...(readOptions.legacyEnvKeys ?? [])]) {
          const token = savedTokens.get(key)
          if (token) return token
        }
        return null
      })
    },
    setSessionToken: (token: string, envKey: string) => {
      tokenWrites.push({ seq: nextSeq(), value: token })
      secretsSeen.push(token)
      // A team switch writes its token through the same method (`appService.ts:1302`).
      const point: HoldPoint | null = switchTokens.has(token) ? null : 'installTokenWrite'
      return passThrough(point, 'tokenStore.setSessionToken', held => {
        refuseResponse('installTokenWrite')(held)
        savedTokens.set(envKey, token)
      })
    },
    clearSessionToken: (envKey: string, clearOptions: { legacyEnvKeys?: readonly string[] } = {}) =>
      deliver('tokenStore.clearSessionToken', () => {
        for (const key of [envKey, ...(clearOptions.legacyEnvKeys ?? [])]) savedTokens.delete(key)
      }),
  }

  const rawService = new AppServiceClass({
    tokenStore: tokenStore as unknown as TokenStore,
    browserSignInLinksAvailable: options.linksAvailable ?? false,
    browserSignInClock: clock,
    onSessionGenerationAdvanced: value => {
      bumpLog.push({ seq: nextSeq(), value })
      options.onSessionGenerationAdvanced?.(value)
    },
  })
  const recordReply = (reply: unknown) => {
    const text = replyText(reply)
    if (text !== null) secretsSeen.push(text)
  }
  // Every reply of a public method is visible to the harness, as an IPC reply would be.
  const service = new Proxy(rawService, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args)
        if (!(result instanceof Promise)) {
          recordReply(result)
          return result
        }
        return result.then(
          reply => {
            recordReply(reply)
            return reply
          },
          (error: unknown) => {
            recordReply(error instanceof Error ? error.message : error)
            throw error
          }
        )
      }
    },
  })

  return {
    service,
    envs: Object.freeze(envs),
    fetches,
    tokenWrites,
    tokenReads,
    opens,
    bumpLog,
    clock,
    secretsSeen,
    unrouted,
    routes,
    hold(point) {
      const pending: PendingHold = { reached: false, released: false, answer: deferred() }
      const queue = holds.get(point) ?? []
      queue.push(pending)
      holds.set(point, queue)
      return {
        release(answer) {
          if (pending.released) throw new Error(`the ${point} hold was already released`)
          pending.released = true
          pending.answer.resolve(answer)
        },
        get reached() {
          return pending.reached
        },
      }
    },
    async drain(drainOptions = {}) {
      const owner = drainOptions.owner !== false
      // The owner queue is awaited inside the loop, not after it: an owner op may wait on an
      // answer that only the scheduler delivers. Each turn that found it settled asks again, so
      // a quiet turn means an op queued since was settled too.
      let ownerSettled = !owner
      let ownerAsked = false
      let quietTurns = 0
      for (let turn = 0; quietTurns < DRAIN_QUIET_TURNS; turn += 1) {
        if (turn >= DRAIN_TURN_LIMIT) {
          throw new Error(
            ownerSettled
              ? `drain: the scheduler was still busy after ${DRAIN_TURN_LIMIT} turns`
              : `drain: the auth owner queue had not settled after ${DRAIN_TURN_LIMIT} turns` +
                  ' (a hold under an owner op needs drain({ owner: false }))'
          )
        }
        if (owner && !ownerAsked) {
          ownerAsked = true
          ownerSettled = false
          void rawService.whenAuthCommitsSettled().then(() => {
            ownerSettled = true
            ownerAsked = false
          })
        }
        if (scheduler && scheduler.count() > 0) await scheduler.waitIdle()
        await new Promise<void>(resolve => setImmediate(resolve))
        const schedulerBusy = scheduler !== undefined && scheduler.count() > 0
        quietTurns = schedulerBusy || !ownerSettled ? 0 : quietTurns + 1
      }
    },
  }
}

/**
 * Undoes every live harness, newest first: each one saved the environment and `fetch` as the
 * harness before it had left them, so only that order ends on what the test had. It undoes only
 * what a harness set; the calling test's own stubs stay.
 */
export async function cleanupBrowserSignInHarness(): Promise<void> {
  const unrouted: string[] = []
  for (const active of activeHarnesses.splice(0).reverse()) {
    active.restoreConsole()
    active.restoreFetch()
    for (const [name, value] of Object.entries(active.savedEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await fs.rm(active.userDataDir, { recursive: true, force: true })
    unrouted.push(...active.unrouted)
  }
  vi.doUnmock('electron')
  vi.doUnmock('../src/chatStoreBinding.js')
  vi.resetModules()
  if (unrouted.length) {
    throw new Error(`browserSignInHarness: requests without a route: ${unrouted.join(', ')}`)
  }
}
