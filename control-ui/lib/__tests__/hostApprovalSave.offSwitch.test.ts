/**
 * "Set to Manual now" (spec §6.3 steps 1–6), named after the spec §7 A3 rows it
 * settles: R4, R5, R12, R13s, R19, R21 and R22.
 *
 * Only `fetch` is replaced, by the fake control-api with the version rule on
 * (control-api since spec §6.8), so the real `getHost`, `apiSend`, in-flight
 * GET map and `formatApiError` run (spec A6). The protocol runs on a virtual
 * clock with a seeded random source: no test waits for a real timeout or a
 * real backoff. An answer that stands for another component's is that
 * component's: control-api's 403, 409, 422 and 500 bodies
 * (control-api/test/fixtures/wire), the proxy's 502 and 504
 * (test/fixtures/wire), or the fake's own answer, which
 * control-api/test/routes.hostPut.fakeContract.test.ts pins to the real routes.
 * No producer answers 429 on these routes (they mount no rate limiter, spec
 * A6), so the 429 tests send one with no body; three of them add a
 * `Retry-After` header whose value is the test's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { STATUS_CODES } from 'node:http'
import { resolve } from 'node:path'
import {
  type VirtualClock,
  createVirtualClock,
  seededRandom,
} from '../../test/fixtures/approvalClock'
import { materializeHostResource } from '../../test/fixtures/contextResource'
import {
  type FakeControlApi,
  type FakeControlApiOptions,
  type FakeLogEntry,
  type HostObject,
  createFakeControlApi,
} from '../../test/fixtures/fakeControlApi'
import {
  AuthExpiredError,
  REQUEST_TIMED_OUT_MESSAGE,
  formatApiError,
  getHost,
  setGlobalAuthErrorHandler,
} from '../api'
import {
  type OffSwitchOutcome,
  __resetHostApprovalSaveForTests,
  __setApprovalClockForTests,
  isSettingManual,
  notStoredMessage,
  saveTools,
  setManualNow,
  subscribeSettingManual,
} from '../hostApprovalSave'
import { __resetReadRequestCacheForTests } from '../readRequestCache'

const FOO = '/api/v1/admin/hosts/foo'
/** Spec §6.3 step 2 and A4 C1: each request of the switch. */
const REQUEST_MS = 8_000
/** Spec §6.3 step 4: no attempt starts later than this after the call. */
const BUDGET_MS = 20_000

// Spec §6.3 step 6, verbatim.
const FALLBACK = `kubectl -n <namespace> patch host <name> --type=json -p '[{"op":"replace","path":"/spec/approval/modeCeiling","value":"manual"}]'`
// Spec §6.4 step 13, verbatim: the per-tool save's outcome in T22.
const MAYBE = 'The save may not have applied. Reload to check.'

function fallback(namespace: string, name: string): string {
  return FALLBACK.replace('<namespace>', namespace).replace('<name>', name)
}

type WireAnswer = { status: number; body: unknown }

function readWire(path: string): WireAnswer {
  return JSON.parse(readFileSync(resolve(__dirname, path), 'utf8')) as WireAnswer
}

// The proxy's own answers (app/control-api/[...path]/route.ts), recorded by its route.wireBodies test.
const PROXY_502 = readWire('../../test/fixtures/wire/proxy-502.wire.json')
const PROXY_504 = readWire('../../test/fixtures/wire/proxy-504.wire.json')
// control-api's answers, recorded by control-api/test/routes.hostPut.fakeContract.test.ts.
const CONTROL_API_WIRE = '../../../control-api/test/fixtures/wire'
const HOST_PUT_403 = readWire(`${CONTROL_API_WIRE}/host-put-403.wire.json`)
const HOST_PUT_409 = readWire(`${CONTROL_API_WIRE}/host-put-409.wire.json`)
const HOST_PUT_422 = readWire(`${CONTROL_API_WIRE}/host-put-422.wire.json`)
// clerumErrorHandler's production 500, which it answers for any unexpected
// error; recorded on a /detail read.
const CONTROL_API_500 = readWire(`${CONTROL_API_WIRE}/host-detail-500.wire.json`)

/** The message the real client gives a PUT answered with `answer` (apiSend's formatApiError). */
function putMessage(answer: WireAnswer, headers: Record<string, string> = {}): string {
  const text = answer.body === undefined ? '' : JSON.stringify(answer.body)
  const response = new Response(text, {
    status: answer.status,
    statusText: STATUS_CODES[answer.status],
    headers,
  })
  return formatApiError(response, text).message
}

// The per-tool save of T14 and T22: system_info, whose default is Skip, moves
// to Required, which never loosens (spec §6.6), so no dialog was confirmed.
const BASE_TOOLS = { json_transform: true }
const DRAFT_TOOLS = { json_transform: true, system_info: true }

function toolsSave() {
  return {
    host: 'foo',
    base: { ...BASE_TOOLS },
    baseInherited: false,
    draftTools: { ...DRAFT_TOOLS },
    confirmedItems: [],
  }
}

function seedHost(name: string, spec: Record<string, unknown> = {}): HostObject {
  return materializeHostResource(
    {
      metadata: { name },
      spec: {
        host: name,
        contextRef: 'ctx-a',
        secretRef: `${name}-llm`,
        channels: [],
        model: { provider: 'claude', name: 'claude-sonnet-4-6' },
      },
    },
    { spec }
  )
}

/** The fake control-api as control-api runs since spec §6.8, in place of `fetch`. Host foo lives in mcp-host. */
function createFake(
  approval: Record<string, unknown> | null | undefined,
  options: {
    crd?: 'current' | 'v0.12.1'
    spec?: Record<string, unknown>
    schedule?: FakeControlApiOptions['schedule']
  } = {}
): FakeControlApi {
  const spec = { ...options.spec, ...(approval === undefined ? {} : { approval }) }
  const fake = createFakeControlApi({
    hosts: { foo: seedHost('foo', spec) },
    crd: options.crd ?? 'current',
    versionRule: true,
    schedule: options.schedule,
  })
  vi.stubGlobal('fetch', fake.fetch)
  return fake
}

/**
 * A fake whose version moves just before each of the first `conflicts` PUTs
 * applies, as an HCC status write does (spec E6), so each of them meets a 409.
 * `starts` records the virtual time at which each read arrives: when each
 * attempt starts.
 */
function conflictingFake(
  approval: Record<string, unknown>,
  conflicts: number
): { fake: FakeControlApi; starts: number[] } {
  const starts: number[] = []
  let left = conflicts
  const fake: FakeControlApi = createFake(approval, {
    schedule: async (point, entry) => {
      if (point === 'arrival' && entry.kind === 'read') starts.push(clock.now())
      if (point === 'apply' && entry.kind === 'write' && left > 0) {
        left -= 1
        fake.bumpVersion('foo', 'status')
      }
    },
  })
  return { fake, starts }
}

/** A fake whose reads of the Host arrive and are never answered. */
function silentReadsFake(approval: Record<string, unknown>): FakeControlApi {
  return createFake(approval, {
    schedule: (point, entry) =>
      point === 'delivery' && entry.kind === 'read'
        ? new Promise<void>(() => {})
        : Promise.resolve(),
  })
}

/**
 * `fetch` with the fake behind it, where a 429 the fake answers also carries
 * `Retry-After: <seconds>`. The header value is the test's own: no producer
 * answers 429 on these routes.
 */
function withRetryAfter(fake: FakeControlApi, seconds: string): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fake.fetch(input, init)
    if (response.status !== 429) return response
    const headers = new Headers(response.headers)
    headers.set('retry-after', seconds)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}

function writes(fake: FakeControlApi): FakeLogEntry[] {
  return fake.log.filter(entry => entry.kind === 'write' && entry.path === FOO)
}

function reads(fake: FakeControlApi): FakeLogEntry[] {
  return fake.log.filter(entry => entry.kind === 'read' && entry.path === FOO)
}

function storedApproval(fake: FakeControlApi): unknown {
  return fake.stored('foo').spec.approval
}

/** The `spec.approval` a logged PUT sent. */
function sentApproval(entry: FakeLogEntry): unknown {
  return (entry.body as { spec: Record<string, unknown> }).spec.approval
}

/** The version of the Host a logged read answered. */
function versionRead(entry: FakeLogEntry): string | undefined {
  return (entry.response?.body as HostObject).metadata.resourceVersion
}

function raiseCeiling(fake: FakeControlApi, ceiling: 'auto' | 'allow_all'): void {
  fake.writeExternal('foo', spec => {
    ;(spec.approval as Record<string, unknown>).modeCeiling = ceiling
  })
}

function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: boolean } {
  const state = { promise, settled: false }
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true)
  )
  return state
}

/** Lets every request the last step started reach its next hold. */
async function flush(): Promise<void> {
  await new Promise(done => setTimeout(done, 0))
}

/** Every timer the switch set that was not a request timeout: its backoffs. */
function backoffs(): number[] {
  return clock.delays.filter(ms => ms !== REQUEST_MS)
}

/**
 * Runs the switch's backoffs until `promise` settles. Whenever the only timer
 * pending is not a request timeout, the clock moves to it. Requests must be
 * answered by the fake: a request left hanging stalls the run.
 */
async function drive<T>(promise: Promise<T>): Promise<T> {
  const run = track(promise)
  while (!run.settled) {
    const next = { ms: undefined as number | undefined }
    await vi.waitFor(
      () => {
        const timers = clock.timers()
        next.ms =
          timers.length === 1 && timers[0].delay !== REQUEST_MS ? timers[0].remaining : undefined
        if (!run.settled && next.ms === undefined) {
          throw new Error('the switch is neither done nor backing off')
        }
      },
      { interval: 1, timeout: 2_000 }
    )
    if (!run.settled && next.ms !== undefined) clock.advance(next.ms)
  }
  return run.promise
}

/**
 * Runs every timer the switch waits on, request timeouts included, once each
 * request sent has arrived: for runs whose every request is left unanswered.
 */
async function driveSilent<T>(fake: FakeControlApi, promise: Promise<T>): Promise<T> {
  const run = track(promise)
  while (!run.settled) {
    const next = { ms: undefined as number | undefined }
    await vi.waitFor(
      () => {
        const timers = clock.timers()
        const quiet = timers.length === 1 && fake.log.every(entry => entry.arrived)
        next.ms = quiet ? timers[0].remaining : undefined
        if (!run.settled && next.ms === undefined) {
          throw new Error('the switch is neither done nor waiting')
        }
      },
      { interval: 1, timeout: 2_000 }
    )
    if (!run.settled && next.ms !== undefined) clock.advance(next.ms)
  }
  return run.promise
}

let clock: VirtualClock

beforeEach(() => {
  __resetReadRequestCacheForTests()
  clock = createVirtualClock()
  __setApprovalClockForTests(clock, seededRandom(17))
})

afterEach(() => {
  __resetHostApprovalSaveForTests()
  __resetReadRequestCacheForTests()
  setGlobalAuthErrorHandler(() => {})
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Set to Manual now (spec §6.3)', () => {
  describe('retries (R4, R13s)', () => {
    it('T4 succeeds after six consecutive 409s inside 20 s', async () => {
      const { fake, starts } = conflictingFake({ modeCeiling: 'auto' }, 6)
      const outcome = await drive(setManualNow('foo'))

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake).map(entry => entry.response?.status)).toEqual([
        409, 409, 409, 409, 409, 409, 200,
      ])
      // Every PUT carries the version of its own fresh read, never an older one.
      expect(writes(fake).map(entry => entry.versionSent)).toEqual(reads(fake).map(versionRead))
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual' })
      // Seven attempts, all started within 20 s on the virtual clock.
      expect(starts).toHaveLength(7)
      expect(Math.max(...starts)).toBeLessThanOrEqual(BUDGET_MS)
      // Six backoffs on the protocol clock, drawn from the seeded source: retry
      // n waits half of min(2 s, 250 ms · 2^(n−1)) plus a random share of the
      // other half. And 8 s for each read and PUT.
      expect(backoffs()).toEqual([155, 455, 729, 1297, 1714, 1332])
      expect(clock.now()).toBe(backoffs().reduce((sum, ms) => sum + ms, 0))
      expect(clock.delays.filter(ms => ms === REQUEST_MS)).toHaveLength(14)
      expect(clock.pending(), 'timers left').toBe(0)
    })

    it('T4 six conflicts fit inside 20 s at the largest backoff draws too', async () => {
      __setApprovalClockForTests(clock, () => 0.999_999)
      const { fake, starts } = conflictingFake({ modeCeiling: 'auto' }, 6)
      const outcome = await drive(setManualNow('foo'))

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(starts).toHaveLength(7)
      expect(Math.max(...starts)).toBeLessThanOrEqual(BUDGET_MS)
      // The largest backoffs there are: just under 250 ms doubling to the 2 s cap.
      expect(backoffs()).toEqual([249, 499, 999, 1999, 1999, 1999])
    })

    it('T4 page data says Manual, the Host says Auto: it writes', async () => {
      const fake = createFake({ modeCeiling: 'manual' })
      // The tab's load, which took the Host while it was Manual.
      const page = await getHost('foo', { signal: new AbortController().signal })
      raiseCeiling(fake, 'auto')
      const outcome = await setManualNow('foo', { namespace: page.metadata?.namespace })

      expect(page.spec?.approval, 'what the page shows').toEqual({ modeCeiling: 'manual' })
      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [true, 200],
      ])
      expect(sentApproval(writes(fake)[0])).toEqual({ modeCeiling: 'manual' })
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual' })
    })

    it('T4u an unanswered PUT is retried and reported as saved, not already', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      // control-api applies the write; its answer is lost.
      put.dropResponse()
      const outcome = await drive(switching)

      // The read after the lost answer shows Manual: this run's own write.
      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake).map(entry => [entry.applied, entry.delivered])).toEqual([[true, false]])
      expect(reads(fake), 'the fresh read and the read after the lost answer').toHaveLength(2)
      expect(reads(fake)[1].seq).toBeGreaterThan(writes(fake)[0].seq)
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual' })
    })

    it('a PUT refused with 409 wrote nothing: a later read showing Manual is already', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      // Another admin lowers the ceiling before the switch's PUT is applied.
      fake.writeExternal('foo', spec => {
        ;(spec.approval as Record<string, unknown>).modeCeiling = 'manual'
      })
      put.deliverNow()
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'already', stored: fake.stored('foo'), inherited: false })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [false, 409],
      ])
      expect(reads(fake), 'the fresh read and the read after the 409').toHaveLength(2)
    })

    it('a 2xx PUT answer that is no Host may have written: the next Manual read is saved, not already', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      // control-api applies the write; the answer the client gets is a 200 with no body.
      put.applyNow()
      await vi.waitFor(() => expect(writes(fake)[0].applied).toBe(true))
      put.respondWith(200, undefined)
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(
        writes(fake).map(entry => [entry.applied, entry.delivered, entry.response?.status])
      ).toEqual([[true, true, 200]])
      expect(reads(fake), 'the fresh read and the read after the answer').toHaveLength(2)
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual' })
    })

    it("R13s a PUT stored but answered by control-api's 500 is saved, not already", async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      // control-api stores the write, then answers 500: a failed commit after
      // the replace (spec §3).
      put.applyNow()
      await vi.waitFor(() => expect(writes(fake)[0].applied).toBe(true))
      put.respondWith(CONTROL_API_500.status, CONTROL_API_500.body)
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [true, 500],
      ])
      expect(reads(fake), 'the fresh read and the read after the 500').toHaveLength(2)
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual' })
    })

    it.each([
      ["the proxy's 502", PROXY_502],
      ["the proxy's 504", PROXY_504],
      ["control-api's 500", CONTROL_API_500],
    ])('R13s a PUT answered by %s is retried from a fresh read', async (_name, answer) => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      put.respondWith(answer.status, answer.body)
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [false, answer.status],
        [true, 200],
      ])
      expect(writes(fake).map(entry => entry.versionSent)).toEqual(reads(fake).map(versionRead))
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual' })
    })

    it('ends a hung switch PUT at 8 s on the virtual clock and reads again', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = track(setManualNow('foo'))
      await put.arrived
      // control-api applies the write; its answer never comes.
      put.hang()
      put.applyNow()
      await vi.waitFor(() => expect(writes(fake)[0].applied).toBe(true))
      clock.advance(REQUEST_MS - 1)
      await flush()
      expect(switching.settled, 'settled before 8 s').toBe(false)
      expect(reads(fake), 'reads before 8 s').toHaveLength(1)
      clock.advance(1)
      const outcome = await drive(switching.promise)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake).map(entry => entry.delivered)).toEqual([false])
      expect(reads(fake)).toHaveLength(2)
      // The read, the PUT and the second read each ran on an 8 s virtual timer.
      expect(clock.delays.filter(ms => ms === REQUEST_MS)).toHaveLength(3)
      expect(clock.pending(), 'timers left').toBe(0)
    })

    it.each([
      ["control-api's 500", CONTROL_API_500],
      ["the proxy's 502", PROXY_502],
      ["the proxy's 504", PROXY_504],
      // control-api's 409 envelope, recorded on a PUT: no read answers one today.
      ["control-api's 409", HOST_PUT_409],
    ])('a read answered by %s is retried and saves', async (_name, answer) => {
      const fake = createFake({ modeCeiling: 'auto' })
      const read = fake.hold({ method: 'GET', path: FOO })
      const switching = setManualNow('foo')
      await read.arrived
      read.respondWith(answer.status, answer.body)
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(reads(fake).map(entry => entry.response?.status)).toEqual([answer.status, 200])
      expect(writes(fake)).toHaveLength(1)
      expect(backoffs(), 'one backoff between the reads').toHaveLength(1)
    })

    it('a read answered with no Host is retried, never taken as Already Manual', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const read = fake.hold({ method: 'GET', path: FOO })
      const switching = setManualNow('foo')
      await read.arrived
      // A 200 with no body: nothing in it says the ceiling is Manual.
      read.respondWith(200, undefined)
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(reads(fake).map(entry => [entry.delivered, entry.response?.status])).toEqual([
        [true, 200],
        [true, 200],
      ])
      expect(writes(fake)).toHaveLength(1)
    })

    it('a read answered with a Host object that has no spec is not taken as inheriting', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const read = fake.hold({ method: 'GET', path: FOO })
      const switching = setManualNow('foo')
      await read.arrived
      // The fake's own Host object, without its spec: read as a Host, it would
      // have no approval block, which is inheriting, and so Already Manual.
      read.respondWith(200, { metadata: fake.stored('foo').metadata })
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(reads(fake).map(entry => [entry.delivered, entry.response?.status])).toEqual([
        [true, 200],
        [true, 200],
      ])
      expect(writes(fake)).toHaveLength(1)
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual' })
    })
  })

  describe('429 (no recorded body: these routes mount no rate limiter)', () => {
    it('a 429 with no body and no Retry-After is retried after a backoff', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      put.respondWith(429, undefined)
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [false, 429],
        [true, 200],
      ])
      // The first backoff, with nothing added for a Retry-After.
      expect(backoffs()).toHaveLength(1)
      expect(backoffs()[0]).toBeLessThan(250)
    })

    it('a 429 with Retry-After waits that long on the virtual clock before the next attempt', async () => {
      const starts: number[] = []
      const fake = createFake(
        { modeCeiling: 'auto' },
        {
          schedule: async (point, entry) => {
            if (point === 'arrival' && entry.kind === 'read') starts.push(clock.now())
          },
        }
      )
      withRetryAfter(fake, '3')
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      put.respondWith(429, undefined)
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake).map(entry => entry.response?.status)).toEqual([429, 200])
      expect(starts).toHaveLength(2)
      expect(starts[1]).toBeGreaterThanOrEqual(3_000)
      expect(starts[1]).toBeLessThan(3_250)
    })

    it('a 429 on the read waits its Retry-After too', async () => {
      const starts: number[] = []
      const fake = createFake(
        { modeCeiling: 'auto' },
        {
          schedule: async (point, entry) => {
            if (point === 'arrival' && entry.kind === 'read') starts.push(clock.now())
          },
        }
      )
      withRetryAfter(fake, '3')
      const read = fake.hold({ method: 'GET', path: FOO })
      const switching = setManualNow('foo')
      await read.arrived
      read.respondWith(429, undefined)
      const outcome = await drive(switching)

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(reads(fake).map(entry => entry.response?.status)).toEqual([429, 200])
      expect(writes(fake), 'PUTs').toHaveLength(1)
      expect(starts).toHaveLength(2)
      expect(starts[1]).toBeGreaterThanOrEqual(3_000)
      expect(starts[1]).toBeLessThan(3_250)
    })

    it('a Retry-After past the 20 s budget fails at once with the fallback', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      withRetryAfter(fake, '30')
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      put.respondWith(429, undefined)
      const outcome = await switching

      const message = putMessage({ status: 429, body: undefined }, { 'retry-after': '30' })
      expect(message, "the client's 429 message").toBe(
        'Too many requests. Try again in 30 seconds.'
      )
      expect(outcome).toEqual({ kind: 'failed', message, fallback: fallback('mcp-host', 'foo') })
      expect(clock.now(), 'no wait').toBe(0)
      expect(backoffs()).toEqual([])
      expect(writes(fake), 'PUTs').toHaveLength(1)
      expect(reads(fake), 'reads').toHaveLength(1)
    })
  })

  describe('prune check (R5)', () => {
    it('T5 a pruned modeCeiling counts as stored', async () => {
      // The block was written under a newer CRD; the fake serves seeds as
      // given, and the v0.12.1 CRD prunes modeCeiling on write.
      const fake = createFake(
        { modeCeiling: 'auto', tools: { system_info: true } },
        { crd: 'v0.12.1' }
      )
      const outcome = await setManualNow('foo')

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(sentApproval(writes(fake)[0]), 'what the PUT sent').toEqual({
        modeCeiling: 'manual',
        tools: { system_info: true },
      })
      // The cluster dropped modeCeiling: absent reads as Manual.
      expect(storedApproval(fake), 'what the cluster stored').toEqual({
        tools: { system_info: true },
      })
      expect(writes(fake).map(entry => entry.applied)).toEqual([true])
    })

    it('a PUT answer whose ceiling is not Manual is not reported as saved', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      // A 2xx carrying the Host as stored now, still auto: the fake's own
      // object; only its pairing with this PUT is modelled.
      put.respondWith(200, fake.stored('foo'))
      const outcome = await switching

      expect(outcome).toEqual({
        kind: 'failed',
        message: notStoredMessage(['modeCeiling']),
        fallback: fallback('mcp-host', 'foo'),
      })
      expect(writes(fake).map(entry => [entry.delivered, entry.response?.status])).toEqual([
        [true, 200],
      ])
    })
  })

  describe('already Manual (spec §6.3 step 3)', () => {
    it('inheriting Host: already, no write, inherited true', async () => {
      const fake = createFake(undefined)
      const outcome = await setManualNow('foo')

      expect(outcome).toEqual({ kind: 'already', stored: fake.stored('foo'), inherited: true })
      expect(reads(fake), "the switch's own read").toHaveLength(1)
      expect(writes(fake), 'PUTs').toEqual([])
      // The switch never creates the block.
      expect(fake.stored('foo').spec).not.toHaveProperty('approval')
    })

    it('a null approval block inherits, as mcp-host reads it', async () => {
      const fake = createFake(null)
      const outcome = await setManualNow('foo')

      expect(outcome).toEqual({ kind: 'already', stored: fake.stored('foo'), inherited: true })
      expect(reads(fake), "the switch's own read").toHaveLength(1)
      expect(writes(fake), 'PUTs').toEqual([])
    })

    it.each([
      ['a Manual ceiling', { modeCeiling: 'manual' }],
      ['an empty block', {}],
      ['an invalid ceiling', { modeCeiling: 'MANUAL' }],
    ])('%s of its own: already, no write, inherited false', async (_name, approval) => {
      const fake = createFake(approval)
      const outcome = await setManualNow('foo')

      expect(outcome).toEqual({ kind: 'already', stored: fake.stored('foo'), inherited: false })
      expect(reads(fake), "the switch's own read").toHaveLength(1)
      expect(writes(fake), 'PUTs').toEqual([])
      expect(storedApproval(fake)).toEqual(approval)
    })
  })

  describe('single-flight per Host (R19)', () => {
    it('T19 a second call while running returns the running promise', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const seen: boolean[] = []
      const unsubscribe = subscribeSettingManual(() => seen.push(isSettingManual('foo')))
      const first = setManualNow('foo')
      expect(isSettingManual('foo')).toBe(true)
      expect(isSettingManual('bar'), 'another Host').toBe(false)
      const second = setManualNow('foo')
      expect(second).toBe(first)
      await put.arrived
      put.deliverNow()
      const outcome = await first

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(writes(fake), 'one PUT').toHaveLength(1)
      expect(reads(fake), 'one read').toHaveLength(1)
      expect(isSettingManual('foo')).toBe(false)
      // Told when the run started and when it ended.
      expect(seen).toEqual([true, false])
      unsubscribe()

      // A call after the run ended starts a new run.
      const third = setManualNow('foo')
      expect(third).not.toBe(first)
      expect(await third).toEqual({
        kind: 'already',
        stored: fake.stored('foo'),
        inherited: false,
      })
      expect(reads(fake), 'the new run read again').toHaveLength(2)
      expect(seen, 'no news after unsubscribing').toEqual([true, false])
    })

    it('a run that throws still ends: the flag clears and listeners hear it', async () => {
      createFake({ modeCeiling: 'auto' })
      const failure = new Error('the clock failed')
      __setApprovalClockForTests(
        {
          ...clock,
          setTimeout: () => {
            throw failure
          },
        },
        seededRandom(17)
      )
      const seen: boolean[] = []
      const unsubscribe = subscribeSettingManual(() => seen.push(isSettingManual('foo')))
      const run = setManualNow('foo')
      expect(isSettingManual('foo')).toBe(true)

      await expect(run).rejects.toBe(failure)
      expect(isSettingManual('foo')).toBe(false)
      expect(seen).toEqual([true, false])
      unsubscribe()
    })

    it('a listener that throws changes no outcome, the others still hear, and its error is reported', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const reported = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const failure = new Error('a listener failed')
      const throwing = vi.fn(() => {
        throw failure
      })
      const seen: boolean[] = []
      subscribeSettingManual(throwing)
      subscribeSettingManual(() => seen.push(isSettingManual('foo')))
      const outcome = await setManualNow('foo')

      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(throwing, 'told at the start and at the end').toHaveBeenCalledTimes(2)
      expect(seen, 'the listener after it, told both times').toEqual([true, false])
      expect(reported.mock.calls).toEqual([
        [expect.stringContaining('listener'), failure],
        [expect.stringContaining('listener'), failure],
      ])
    })

    it('the test reset forgets a running switch and its listeners', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const oldPut = fake.hold({ method: 'PUT', path: FOO })
      const listener = vi.fn()
      subscribeSettingManual(listener)
      const old = setManualNow('foo')
      expect(listener, 'told of the start').toHaveBeenCalledTimes(1)
      await oldPut.arrived
      __resetHostApprovalSaveForTests()
      expect(isSettingManual('foo')).toBe(false)

      // A run started after the reset is a new one, and the old run's end
      // does not clear it.
      __setApprovalClockForTests(clock, seededRandom(17))
      const newPut = fake.hold({ method: 'PUT', path: FOO })
      const fresh = setManualNow('foo')
      expect(fresh).not.toBe(old)
      await newPut.arrived
      oldPut.deliverNow()
      expect(await old).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(isSettingManual('foo'), 'the new run still runs').toBe(true)
      expect(listener, 'the reset dropped the listener').toHaveBeenCalledTimes(1)
      newPut.deliverNow()
      // The old run's write moved the version, so the new run's PUT met a 409
      // and its next read found Manual, which it did not write.
      expect(await drive(fresh)).toEqual({
        kind: 'already',
        stored: fake.stored('foo'),
        inherited: false,
      })
      expect(isSettingManual('foo')).toBe(false)
    })
  })

  describe('with a per-tool save (R12, R21, R22)', () => {
    it('T14 a per-tool save in flight and the switch both land', async () => {
      const fake = createFake({ modeCeiling: 'auto', tools: { ...BASE_TOOLS } })
      const toolsPut = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await toolsPut.arrived
      const switched = await setManualNow('foo')
      toolsPut.deliverNow()
      const saved = await saving

      const [firstToolsPut, switchPut, toolsRetry] = writes(fake)
      expect(switched).toEqual({ kind: 'saved', stored: switchPut.response?.body })
      expect(saved).toEqual({ kind: 'saved', stored: fake.stored('foo'), via: 'response' })
      // The per-tool PUT carried the version of a read before the switch's
      // write, so it met a 409; its retry read again and copied Manual.
      expect(writes(fake).map(entry => entry.response?.status)).toEqual([409, 200, 200])
      expect(writes(fake).map(entry => entry.versionSent)).toEqual(reads(fake).map(versionRead))
      expect(sentApproval(firstToolsPut)).toEqual({ modeCeiling: 'auto', tools: DRAFT_TOOLS })
      expect(sentApproval(toolsRetry)).toEqual({ modeCeiling: 'manual', tools: DRAFT_TOOLS })
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual', tools: DRAFT_TOOLS })
    })

    it('T22 a per-tool PUT read before the switch and applied after it is refused', async () => {
      const fake = createFake({ modeCeiling: 'auto', tools: { ...BASE_TOOLS } })
      const toolsPut = fake.hold({ method: 'PUT', path: FOO })
      const saving = saveTools(toolsSave())
      await toolsPut.arrived
      // The browser gives up on the per-tool PUT at 10 s; control-api still has it.
      toolsPut.hang()
      clock.advance(10_000)
      expect(await saving).toEqual({ kind: 'maybe', message: MAYBE })
      const switched = await setManualNow('foo')
      // control-api finishes the abandoned PUT after the switch's write.
      toolsPut.applyNow()
      await vi.waitFor(() => expect(writes(fake)[0].response?.status).toBe(409))

      const [abandoned, switchPut] = writes(fake)
      expect(switched).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(switchPut.applied, "the switch's write").toBe(true)
      expect(abandoned).toMatchObject({ applied: false, delivered: false })
      expect(sentApproval(abandoned)).toEqual({ modeCeiling: 'auto', tools: DRAFT_TOOLS })
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual', tools: BASE_TOOLS })
    })

    it('C9 partner: a read in flight that saw Manual before a raise does not make the switch already', async () => {
      const fake = createFake({ modeCeiling: 'manual' })
      const otherHold = fake.hold({ method: 'GET', path: FOO })
      // Another reader of the Host, with no signal: a read without one would join it.
      const other = getHost('foo')
      await otherHold.arrived
      raiseCeiling(fake, 'auto')
      const switching = setManualNow('foo')
      otherHold.deliverNow()
      const outcome = await switching

      expect((await other).spec?.approval, 'what the other read saw').toEqual({
        modeCeiling: 'manual',
      })
      expect(outcome).toEqual({ kind: 'saved', stored: fake.stored('foo') })
      expect(
        reads(fake).filter(entry => entry.arrived),
        'GET /hosts/foo arrivals'
      ).toHaveLength(2)
      expect(writes(fake).map(entry => entry.applied)).toEqual([true])
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'manual' })
    })
  })

  describe('failure (spec §6.3 step 6)', () => {
    it('budget out returns the kubectl fallback', async () => {
      const { fake, starts } = conflictingFake({ modeCeiling: 'auto' }, Infinity)
      // The run's own read names the namespace; the caller's is older.
      const outcome = await drive(setManualNow('foo', { namespace: 'from-the-page' }))

      expect(outcome).toEqual({
        kind: 'failed',
        message: putMessage(HOST_PUT_409),
        fallback: fallback('mcp-host', 'foo'),
      })
      expect(writes(fake).every(entry => entry.response?.status === 409)).toBe(true)
      expect(writes(fake).map(entry => entry.versionSent)).toEqual(reads(fake).map(versionRead))
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'auto' })
      // It kept trying until the 20 s mark, and started nothing after it.
      expect(starts.length).toBeGreaterThan(7)
      expect(Math.max(...starts)).toBe(BUDGET_MS)
      expect(clock.now()).toBe(BUDGET_MS)
      expect(clock.pending(), 'timers left').toBe(0)
    })

    it('a backoff timer that fires late never starts an attempt after 20 s', async () => {
      // A throttled background tab: each backoff fires 3 s late, while the
      // request timeouts keep time.
      __setApprovalClockForTests(
        {
          ...clock,
          setTimeout: (fn, ms) => clock.setTimeout(fn, ms === REQUEST_MS ? ms : ms + 3_000),
        },
        seededRandom(17)
      )
      const { fake, starts } = conflictingFake({ modeCeiling: 'auto' }, Infinity)
      const outcome = await drive(setManualNow('foo'))

      expect(outcome).toEqual({
        kind: 'failed',
        message: putMessage(HOST_PUT_409),
        fallback: fallback('mcp-host', 'foo'),
      })
      expect(Math.max(...starts), 'the last attempt start').toBeLessThanOrEqual(BUDGET_MS)
      // The last backoff fired after the 20 s mark, and the run ended there.
      expect(clock.now()).toBeGreaterThan(BUDGET_MS)
      expect(clock.pending(), 'timers left').toBe(0)
      expect(writes(fake).every(entry => entry.response?.status === 409)).toBe(true)
    })

    it('a 422 returns its field message and the fallback', async () => {
      // A model name with no provider: control-api validates the whole spec,
      // so a field the switch did not touch refuses it.
      const fake = createFake(
        { modeCeiling: 'auto' },
        { spec: { model: { name: 'claude-sonnet-4-6' } } }
      )
      const outcome = await setManualNow('foo')

      const [refusal] = (HOST_PUT_422.body as { errors: Array<{ field: string; message: string }> })
        .errors
      expect(outcome).toEqual({
        kind: 'failed',
        message: `${refusal.field}: ${refusal.message}`,
        fallback: fallback('mcp-host', 'foo'),
      })
      expect(writes(fake).map(entry => [entry.applied, entry.response?.status])).toEqual([
        [false, 422],
      ])
      expect(reads(fake), 'no retry').toHaveLength(1)
    })

    it('a 403 on the PUT returns its formatted error and the fallback, with no retry', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const put = fake.hold({ method: 'PUT', path: FOO })
      const switching = setManualNow('foo')
      await put.arrived
      put.respondWith(HOST_PUT_403.status, HOST_PUT_403.body)
      const outcome = await switching

      const message = putMessage(HOST_PUT_403)
      expect(message).toContain((HOST_PUT_403.body as { error: string }).error)
      expect(outcome).toEqual({ kind: 'failed', message, fallback: fallback('mcp-host', 'foo') })
      expect(writes(fake), 'PUTs').toHaveLength(1)
      expect(reads(fake), 'reads').toHaveLength(1)
      expect(storedApproval(fake)).toEqual({ modeCeiling: 'auto' })
    })

    describe('a 4xx on the read ends the run, as on the PUT (ruling 35)', () => {
      it('a 403 on the read ends the run at once with the fallback, with no PUT', async () => {
        const fake = createFake({ modeCeiling: 'auto' })
        const read = fake.hold({ method: 'GET', path: FOO })
        const switching = setManualNow('foo', { namespace: 'from-the-page' })
        await read.arrived
        // control-api's 403 envelope, recorded on a PUT.
        read.respondWith(HOST_PUT_403.status, HOST_PUT_403.body)
        const outcome = await drive(switching)
        const logged = fake.log.map(entry => [entry.kind, entry.response?.status])
        const waited = clock.now()

        // The message the real client gives the same read.
        const oracle = fake.hold({ method: 'GET', path: FOO })
        const message = getHost('foo', { signal: new AbortController().signal }).then(
          () => 'no error',
          (error: unknown) => (error as Error).message
        )
        await oracle.arrived
        oracle.respondWith(HOST_PUT_403.status, HOST_PUT_403.body)
        expect(logged, 'one read, no PUT').toEqual([['read', 403]])
        expect(waited, 'no wait').toBe(0)
        expect(backoffs()).toEqual([])
        expect(await message).not.toBe('no error')
        // No read succeeded, so the fallback names the caller's namespace.
        expect(outcome).toEqual({
          kind: 'failed',
          message: await message,
          fallback: fallback('from-the-page', 'foo'),
        })
      })

      it('a 404 on the read ends the run at once with the fallback, with no PUT', async () => {
        // The fake's own 404 for a missing Host, pinned to the real route by
        // the contract test's missing-Host step.
        const fake = createFake({ modeCeiling: 'auto' })
        const outcome = await drive(setManualNow('gone'))
        const logged = fake.log.map(entry => [entry.kind, entry.response?.status])
        const waited = clock.now()

        // The message the real client gives the same read.
        const message = await getHost('gone', { signal: new AbortController().signal }).then(
          () => 'no error',
          (error: unknown) => (error as Error).message
        )
        expect(logged, 'one read, no PUT').toEqual([['read', 404]])
        expect(waited, 'no wait').toBe(0)
        expect(backoffs()).toEqual([])
        expect(message).not.toBe('no error')
        expect(outcome).toEqual({
          kind: 'failed',
          message,
          fallback: FALLBACK.replace('<name>', 'gone'),
        })
      })

      it('a 401 on the read goes through the session path once and ends the run, with no PUT', async () => {
        const onSessionExpired = vi.fn()
        setGlobalAuthErrorHandler(onSessionExpired)
        const fake = createFake({ modeCeiling: 'auto' })
        const read = fake.hold({ method: 'GET', path: FOO })
        const switching = setManualNow('foo')
        await read.arrived
        // The session path reads the status only, so the answer carries no body.
        read.respondWith(401, undefined)
        const outcome = await drive(switching)

        expect(
          fake.log.map(entry => [entry.kind, entry.response?.status]),
          'one read, no PUT'
        ).toEqual([['read', 401]])
        expect(clock.now(), 'no wait').toBe(0)
        expect(backoffs()).toEqual([])
        expect(onSessionExpired).toHaveBeenCalledTimes(1)
        expect(outcome).toEqual({
          kind: 'failed',
          message: new AuthExpiredError().message,
          fallback: FALLBACK.replace('<name>', 'foo'),
        })
      })
    })

    it('a read without a resourceVersion is never followed by a PUT', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const read = fake.hold({ method: 'GET', path: FOO })
      const switching = setManualNow('foo')
      await read.arrived
      const unversioned = fake.stored('foo')
      delete unversioned.metadata.resourceVersion
      read.respondWith(200, unversioned)
      const outcome = await switching

      // Spec §6.5's refusal for a write that has no version to send.
      expect(outcome).toEqual({
        kind: 'failed',
        message: 'Reload the page to save',
        fallback: fallback('mcp-host', 'foo'),
      })
      expect(reads(fake).map(entry => entry.delivered)).toEqual([true])
      expect(writes(fake), 'PUTs').toEqual([])
    })

    it.each([
      ['the namespace the caller passed', { namespace: 'tenant-a' }, fallback('tenant-a', 'foo')],
      ['the placeholder with no namespace given', {}, FALLBACK.replace('<name>', 'foo')],
    ])(
      'when no read answers, the fallback names %s',
      async (_name, options: { namespace?: string }, expected) => {
        const fake = silentReadsFake({ modeCeiling: 'auto' })
        const outcome: OffSwitchOutcome = await driveSilent(fake, setManualNow('foo', options))

        expect(outcome).toEqual({
          kind: 'failed',
          message: REQUEST_TIMED_OUT_MESSAGE,
          fallback: expected,
        })
        expect(reads(fake).length).toBeGreaterThan(1)
        expect(reads(fake).every(entry => entry.arrived && !entry.delivered)).toBe(true)
        expect(writes(fake), 'PUTs').toEqual([])
        expect(backoffs().length, 'backoffs between the reads').toBe(reads(fake).length - 1)
        expect(clock.pending(), 'timers left').toBe(0)
      }
    )

    it('the fallback never puts a value that is not a Kubernetes name into the command', async () => {
      const fake = createFake({ modeCeiling: 'auto' })
      const outcome = await drive(setManualNow('a b', { namespace: 'ns;id' }))
      const logged = fake.log.map(entry => [entry.kind, entry.response?.status])

      // The message the real client gives the same read.
      const oracle = await getHost('a b', { signal: new AbortController().signal }).then(
        () => 'no error',
        (error: unknown) => (error as Error).message
      )
      expect(logged, "the switch's one read, and no PUT").toEqual([['read', 404]])
      expect(oracle).not.toBe('no error')
      expect(outcome).toEqual({ kind: 'failed', message: oracle, fallback: FALLBACK })
    })
  })
})
