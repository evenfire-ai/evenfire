import { afterEach, describe, expect, it } from 'vitest'
import { FakeWatchServer, type PutRec } from '../../testSupport/gfsWatch/fakeWatchServer.js'
import { TEAM_1, TEAM_2, USER_A, USER_B, key } from '../../testSupport/gfsWatch/sessionTokens.js'
import type { VirtualTimer } from '../../testSupport/gfsWatch/virtualClock.js'
import { WatchHarness } from '../../testSupport/gfsWatch/watchHarness.js'
import { config } from '../config.js'
import { MAX_KEYS, PUT_MAX_ATTEMPTS, T_ACK_MS, T_OPEN_MS, T_PUT_MS } from './watchProtocol.js'

// Scenarios of the main-process watch client: the real client, the real
// `fetch` and `requestJson`, a watch over real HTTP and a virtual clock.

const A = key('file', 0xa)
const B = key('file', 0xb)
const C = key('dir', 0xc)
const D = key('file', 0xd)

let h: WatchHarness
afterEach(async () => {
  const unhandled = h?.unhandled ?? []
  await h?.stop()
  expect(unhandled).toEqual([])
})

const st = () => h.client.inspect()
const linkOf = () => st().link as Record<string, unknown> & { kind: string }
const handle = (x: unknown) => x as VirtualTimer
async function fire(x: unknown): Promise<void> {
  h.clock.fire(handle(x))
  await h.settle()
}
/** The delay of the backoff the link is waiting on. */
const backoffMs = () => {
  const l = linkOf()
  expect(l.kind).toBe('Backoff')
  expect(h.isPending(l.timer)).toBe(true)
  return handle(l.timer).ms
}
const puts = () => h.server.puts
const gets = () => h.server.gets
const openPut = (): PutRec =>
  puts()
    .filter(p => !p.answered && !p.closed)
    .at(-1)!

async function start(opts: { keys?: string[] } = {}): Promise<void> {
  h = await new WatchHarness().start()
  await h.login()
  if (opts.keys) await h.subscribe(opts.keys)
}

/** The link's timed exit exists for its state (I45, read as pending timers). */
function assertTimedExit(): void {
  const s = st()
  const l = linkOf()
  if (!s.session?.token || s.envSwitching || s.latch || s.unsupportedGeneration !== null) return
  expect(l.kind).not.toBe('Idle')
  if (l.kind === 'Backoff') expect(h.isPending(l.timer)).toBe(true)
  if (l.kind === 'Opening') expect(h.isPending(l.tOpen)).toBe(true)
  if (l.kind === 'Ready') expect(h.isPending(l.watchdog)).toBe(true)
  if (s.put?.phase === 'acked') expect(h.isPending(s.put.tAck)).toBe(true)
  if (s.put?.phase === 'sending') expect(h.isPending(s.put.tPut)).toBe(true)
  if (s.put?.phase === 'retry') expect(h.isPending(s.put.retryTimer)).toBe(true)
}

describe('key set changes over PUT', () => {
  it('T-CB1: a key added before its ack is resynced after its subscriptions frame', async () => {
    await start()
    await h.until(() => h.linkKind() === 'Ready')
    h.server.putPolicy = () => ({ kind: 'hold' })
    await h.subscribe([A])
    await h.until(() => h.server.openPuts().length === 1)
    const owner = h.owner()
    // A write on A while the PUT is unacknowledged produces no `changed` for it:
    // the server only notifies accepted keys, so the resync is what shows v2.
    expect(owner.ofType('changed')).toEqual([])
    const before = owner.events.length
    h.server.answerPut(openPut(), { kind: 'accept' })
    await h.until(() => st().put === null)
    expect(owner.events.slice(before)).toContainEqual({ type: 'resync', keys: [A] })
    // From then on a write on A is forwarded as the server sends it.
    h.server.frame({ type: 'changed', keys: [A] })
    await h.until(() => owner.ofType('changed').length > 0)
    expect(owner.ofType('changed')).toEqual([{ type: 'changed', keys: [A] }])
  })

  it('T-CB2: five list changes during one PUT cost two PUTs and no open', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'hold' })
    const o = h.owner()
    const uid = st().session!.binding!.userId
    for (const keys of [[A], [B], [A, B], [C], [C, D]])
      h.client.setSubscriptions(o, { keys, userId: uid }, o.frameToken)
    await h.settle()
    expect(puts()).toHaveLength(1)
    h.server.putPolicy = () => ({ kind: 'accept' })
    h.server.answerPut(openPut(), { kind: 'accept' })
    await h.settle()
    expect(puts()).toHaveLength(2)
    expect(puts()[1]!.keys).toEqual([C, D])
    expect([...h.server.current()!.keys]).toEqual([C, D])
    expect(gets()).toHaveLength(1)
  })

  it('T-CB2b: a key removed and re-added between two acks is resynced after the second', async () => {
    await start({ keys: [A] })
    h.server.putPolicy = () => ({ kind: 'hold' })
    await h.subscribe([])
    await h.subscribe([A])
    const owner = h.owner()
    const mark = owner.events.length
    h.server.answerPut(openPut(), { kind: 'accept' })
    await h.settle()
    h.server.answerPut(openPut(), { kind: 'accept' })
    await h.settle()
    expect(puts().map(p => p.keys)).toEqual([[A], [], [A]])
    expect(owner.events.slice(mark)).toContainEqual({ type: 'resync', keys: [A] })
  })

  it('T-CB3: a 202 with no subscriptions within T_ack reopens with sent and resyncs', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'accept', frame: false })
    await h.subscribe([A, B])
    expect(st().put?.phase).toBe('acked')
    const tAck = handle(st().put!.tAck)
    expect(tAck.ms).toBe(T_ACK_MS)
    await fire(tAck)
    expect(linkOf().kind).toBe('Backoff')
    await fire(linkOf().timer)
    expect(gets().at(-1)!.keys).toEqual([A, B])
    expect(h.owner().events.at(-2)).toEqual({ type: 'resync', keys: [A, B] })
  })

  it('T-CB4: a deferred key is retried after retryAfterMs and resynced once accepted', async () => {
    await start()
    h.server.putPolicy = rec =>
      rec.n === 1
        ? {
            kind: 'accept',
            decide: keys => ({ accepted: [], rejected: [], deferred: keys, retryAfterMs: 2_000 }),
          }
        : { kind: 'accept' }
    await h.subscribe([A])
    const t = handle(st().deferredTimer)
    expect(t.ms).toBeGreaterThanOrEqual(2_000)
    expect(t.ms).toBeLessThanOrEqual(2_400)
    const mark = h.owner().events.length
    await fire(t)
    expect(puts()).toHaveLength(2)
    expect(puts()[1]!.keys).toEqual([A])
    expect(h.owner().events.slice(mark)).toContainEqual({ type: 'resync', keys: [A] })
    expect(st().deferredTimer).toBeNull()
  })

  it('T-CB16: a new tab during a deferred backoff sends its PUT at once, not when the timer fires', async () => {
    await start()
    h.server.putPolicy = rec =>
      rec.n === 1
        ? {
            kind: 'accept',
            decide: keys => ({ accepted: [], rejected: [], deferred: keys, retryAfterMs: 30_000 }),
          }
        : { kind: 'accept' }
    await h.subscribe([A])
    const t0 = h.clock.elapsed
    await h.subscribe([A, B])
    expect(puts()).toHaveLength(2)
    expect(h.clock.elapsed).toBe(t0)
  })

  it('T-CB11: 80 keys travel as the first 64 by priority, and nothing more is sent after the ack', async () => {
    await start()
    const all = Array.from({ length: 80 }, (_, i) => key('file', i + 1))
    await h.subscribe(all)
    expect(puts()[0]!.keys).toEqual(all.slice(0, MAX_KEYS))
    await h.advance(60_000, { heartbeats: true })
    expect(puts()).toHaveLength(1)
    // A reopen carries the same 64 on the GET.
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    expect(gets().at(-1)!.keys).toEqual(all.slice(0, MAX_KEYS))
  })

  it('keys of a third drive are left out of the PUT and the GET, the rest keep their order', async () => {
    await start()
    const onDrive = (drive: string, n: number) =>
      `file:gfs://${drive}/${n.toString(16).padStart(32, '0')}`
    const [a, b, c, d] = [onDrive('d1', 1), onDrive('d2', 2), onDrive('d3', 3), onDrive('d1', 4)]
    await h.subscribe([a, b, c, d])
    expect(puts().map(p => p.keys)).toEqual([[a, b, d]])
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    expect(gets().at(-1)?.keys).toEqual([a, b, d])
  })

  it('T-CB17: two owners with different lists share one stream with the fused union through reopens', async () => {
    await start()
    await h.subscribe([A, B], 1)
    await h.subscribe([C, A], 2)
    expect(st().sent).toEqual([A, C, B])
    for (let i = 0; i < 3; i++) {
      h.server.eof()
      await h.settle()
      expect(h.server.openStreams().length).toBeLessThanOrEqual(1)
      await fire(linkOf().timer)
      expect(h.server.openStreams()).toHaveLength(1)
      expect(gets().at(-1)!.keys).toEqual([A, C, B])
    }
  })
})

describe('open, backoff and Retry-After', () => {
  it('T-CB7: a server that spends its own deadline answers with deferred keys and causes no reopen', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = () => ({ kind: 'hold' })
    await h.login()
    await h.subscribe([A])
    await h.advance(12_000)
    h.server.answerGet(gets()[0]!, {
      kind: 'ready',
      decide: keys => ({ accepted: [], rejected: [], deferred: keys, retryAfterMs: 5_000 }),
    })
    await h.settle()
    expect(linkOf().kind).toBe('Ready')
    expect(gets()).toHaveLength(1)
  })

  it('T-CB13: 503 with Retry-After 2 → exactly one GET after ≥ 2 s and never two streams', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec =>
      rec.n === 1
        ? { kind: 'error', status: 503, code: 'watch_reopen', retryAfter: '2' }
        : { kind: 'ready' }
    await h.login()
    const ms = backoffMs()
    expect(ms).toBeGreaterThanOrEqual(2_000)
    expect(ms).toBeLessThanOrEqual(2_400)
    await h.advance(1_999)
    expect(gets()).toHaveLength(1)
    await h.advance(ms)
    expect(gets()).toHaveLength(2)
    expect(h.server.openStreams()).toHaveLength(1)
  })

  it('T-CB15: heartbeats every 25 s keep the stream for 10 minutes', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = () => ({ kind: 'ready', heartbeatMs: 25_000 })
    await h.login()
    await h.advance(600_000, { heartbeats: true })
    expect(gets()).toHaveLength(1)
    expect(linkOf().kind).toBe('Ready')
  })

  it('T-CB24: repeated 502s back off up to 15 s and restart after a ready; repeated 403s stay ≥ 60 s with one accessChanged', async () => {
    h = await new WatchHarness().start()
    let fail = 10
    h.server.getPolicy = () => (fail-- > 0 ? { kind: 'error', status: 502 } : { kind: 'ready' })
    await h.login()
    await h.subscribe([])
    const delays: number[] = []
    for (let i = 0; i < 10; i++) {
      delays.push(backoffMs())
      await fire(linkOf().timer)
    }
    expect(linkOf().kind).toBe('Ready')
    expect(delays[0]).toBeGreaterThanOrEqual(1_000)
    expect(delays[0]).toBeLessThanOrEqual(6_000)
    for (let i = 1; i < 10; i++) {
      const base = Math.min(15_000, 1_000 * 2 ** i)
      expect(delays[i]).toBeGreaterThanOrEqual(base)
      expect(delays[i]).toBeLessThanOrEqual(base * 1.2)
    }
    h.server.eof()
    await h.settle()
    expect(backoffMs()).toBeLessThanOrEqual(6_000)

    h.server.getPolicy = () => ({ kind: 'error', status: 403, code: 'gfs_operator_link_invalid' })
    const accessBefore = h.owner().ofType('accessChanged').length
    for (let i = 0; i < 4; i++) {
      await fire(linkOf().timer)
      expect(backoffMs()).toBeGreaterThanOrEqual(60_000)
    }
    expect(h.owner().ofType('accessChanged').length - accessBefore).toBe(1)
  })

  it('T-CB28: Retry-After as 7 s or an HTTP-date at +7 s → GET in [7 s, 8.4 s]; 3600 → 5 min; invalid → local backoff', async () => {
    for (const ra of ['7', 'date', '3600', 'later']) {
      h = await new WatchHarness().start()
      h.server.getPolicy = rec =>
        rec.n === 1
          ? {
              kind: 'error',
              status: 429,
              code: 'rate_limited',
              retryAfter: ra === 'date' ? new Date(h.clock.now() + 7_000).toUTCString() : ra,
            }
          : { kind: 'ready' }
      await h.login()
      const ms = backoffMs()
      if (ra === '7' || ra === 'date') {
        expect(ms).toBeGreaterThanOrEqual(7_000)
        expect(ms).toBeLessThanOrEqual(8_400)
      } else if (ra === '3600') {
        expect(ms).toBeGreaterThanOrEqual(300_000)
        expect(ms).toBeLessThanOrEqual(360_000)
      } else {
        expect(ms).toBeGreaterThanOrEqual(1_000)
        expect(ms).toBeLessThanOrEqual(6_000)
      }
      await h.stop()
    }
    h = await new WatchHarness().start()
  })

  it('T-CB33: the first failure after a ready spreads over [base, base + 5 s]; a frame retryAfterMs is a floor', async () => {
    await start()
    h.server.eof()
    await h.settle()
    const first = backoffMs()
    expect(first).toBeGreaterThanOrEqual(1_000)
    expect(first).toBeLessThanOrEqual(6_000)
    await fire(linkOf().timer)
    h.server.frame({ type: 'stream.closing', reason: 'max_lifetime', retryAfterMs: 4_000 })
    await h.settle()
    const floored = backoffMs()
    expect(floored).toBeGreaterThanOrEqual(4_000)
    expect(floored).toBeLessThanOrEqual(4_800)
  })

  it('T-CB34: any unlisted status backs off at once (open) or retries (PUT); a PUT 400 with sent changed in flight sends now', async () => {
    for (const status of [404, 500, 502, 504]) {
      h = await new WatchHarness().start()
      h.server.getPolicy = rec => (rec.n === 1 ? { kind: 'error', status } : { kind: 'ready' })
      await h.login()
      expect(backoffMs()).toBeLessThan(T_OPEN_MS)
      await fire(linkOf().timer)
      h.server.putPolicy = rec => (rec.n === 1 ? { kind: 'error', status } : { kind: 'accept' })
      await h.subscribe([A])
      expect(st().put?.phase).toBe('retry')
      assertTimedExit()
      await fire(st().put!.retryTimer)
      expect(st().put).toBeNull()
      await h.stop()
    }
    await start()
    h.server.putPolicy = () => ({ kind: 'hold' })
    await h.subscribe([A])
    await h.subscribe([A, B])
    h.server.answerPut(openPut(), { kind: 'error', status: 400, code: 'bad_request' })
    await h.settle()
    expect(puts()).toHaveLength(2)
    expect(puts()[1]!.keys).toEqual([A, B])
    expect(h.clock.elapsed).toBe(0)
  })

  it('T-CB55 (stream without ready): a 2xx whose ready never comes still times out at T_open', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec => (rec.n === 1 ? { kind: 'stream' } : { kind: 'ready' })
    await h.login()
    expect(linkOf().kind).toBe('Opening')
    assertTimedExit()
    await h.advance(T_OPEN_MS)
    expect(linkOf().kind).toBe('Backoff')
    await fire(linkOf().timer)
    expect(linkOf().kind).toBe('Ready')
  })

  it('the first failure after a ready spreads its reopen beyond the jitter', async () => {
    h = await new WatchHarness().start({ random: () => 1 })
    await h.login()
    h.server.eof()
    await h.settle()
    // base 1 s + the whole 5 s spread; the plain jitter would stop at 1.2 s
    expect(backoffMs()).toBeGreaterThan(1_200)
  })

  it('a redirected open is a transient failure and the redirect is not followed', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec =>
      rec.n === 1
        ? { kind: 'redirect', location: '/api/v1/me/gfs/watch?k=followed' }
        : { kind: 'ready' }
    await h.login()
    expect(gets()).toHaveLength(1)
    expect(linkOf().kind).toBe('Backoff')
    await fire(linkOf().timer)
    expect(gets().map(g => g.keys)).toEqual([[], []])
  })

  it('T-CB55: every link state has its timed exit', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec =>
      rec.n === 1
        ? { kind: 'error', status: 503 }
        : rec.n === 2
          ? { kind: 'hold' }
          : { kind: 'ready' }
    await h.login()
    assertTimedExit()
    await fire(linkOf().timer)
    expect(gets()).toHaveLength(2)
    assertTimedExit()
    expect(handle(linkOf().tOpen).ms).toBe(T_OPEN_MS)
    await fire(linkOf().tOpen)
    assertTimedExit()
    await fire(linkOf().timer)
    expect(linkOf().kind).toBe('Ready')
    assertTimedExit()
    const watchdog = handle(linkOf().watchdog)
    expect(watchdog.ms).toBe(3 * 20_000)
    await fire(watchdog)
    assertTimedExit()
    await fire(linkOf().timer)
    h.server.putPolicy = () => ({ kind: 'accept', frame: false })
    await h.subscribe([A])
    assertTimedExit()
    await fire(st().put!.tAck)
    assertTimedExit()
    await fire(linkOf().timer)
    for (const reason of [
      'listener_lost',
      'max_lifetime',
      'server_shutdown',
      'some_future_reason',
      'reauthorize',
    ]) {
      expect(linkOf().kind).toBe('Ready')
      const n = gets().length
      h.server.frame({ type: 'stream.closing', reason, retryAfterMs: 1_500 })
      await h.settle()
      assertTimedExit()
      expect(backoffMs()).toBeGreaterThanOrEqual(1_500)
      await fire(linkOf().timer)
      expect(gets()).toHaveLength(n + 1)
    }
    let once = true
    h.server.getPolicy = () =>
      once
        ? ((once = false),
          { kind: 'error', status: 503, code: 'watch_reauthorize', retryAfter: '1' })
        : { kind: 'ready' }
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    assertTimedExit()
    expect(backoffMs()).toBeGreaterThanOrEqual(1_000)
    await fire(linkOf().timer)
    expect(linkOf().kind).toBe('Ready')
  })
})

describe('frames and stream end', () => {
  it('T-CB26: EOF after the ready leaves Ready in the same tick and reopens once; closing + EOF also reopens once', async () => {
    await start()
    h.server.eof()
    await h.settle()
    expect(linkOf().kind).toBe('Backoff')
    await fire(linkOf().timer)
    expect(gets()).toHaveLength(2)
    h.server.frame({ type: 'stream.closing', reason: 'server_shutdown' })
    h.server.eof()
    await h.settle()
    await h.advance(30_000)
    expect(gets()).toHaveLength(3)
    expect(h.server.openStreams()).toHaveLength(1)
  })

  it('T-CB27: a 17 KB line, broken JSON or a subscriptions without seq is a stream error; a residue at EOF and schemaVersion 2 are not', async () => {
    await start()
    for (const raw of [
      `${'x'.repeat(17 * 1024)}\n`,
      '{"schemaVersion":1,"type":\n',
      `${JSON.stringify({ schemaVersion: 1, type: 'subscriptions', accepted: [], rejected: [], deferred: [] })}\n`,
      'y'.repeat(17 * 1024),
    ]) {
      h.server.write(raw)
      await h.settle()
      expect(linkOf().kind).toBe('Backoff')
      await fire(linkOf().timer)
      expect(linkOf().kind).toBe('Ready')
    }
    const watchdog = handle(linkOf().watchdog)
    h.server.write(JSON.stringify({ schemaVersion: 2, type: 'heartbeat' }) + '\n')
    h.server.frame({ type: 'not_a_frame_yet' })
    await h.settle()
    expect(linkOf().watchdog).toBe(watchdog)
    expect(h.isPending(watchdog)).toBe(true)
    h.server.write(JSON.stringify({ schemaVersion: 1, type: 'changed', keys: [A] }))
    h.server.eof()
    await h.settle()
    expect(h.owner().ofType('changed')).toEqual([])

    // Before the ready, any other known frame is a transient failure; a second ready is a stream error.
    h.server.getPolicy = () => ({ kind: 'stream' })
    await fire(linkOf().timer)
    h.server.frame({ type: 'heartbeat' })
    await h.settle()
    expect(linkOf().kind).toBe('Backoff')
    h.server.getPolicy = () => ({ kind: 'ready' })
    await fire(linkOf().timer)
    h.server.frame({
      type: 'ready',
      connId: 'again',
      heartbeatMs: 20_000,
      accepted: [],
      rejected: [],
      deferred: [],
    })
    await h.settle()
    expect(linkOf().kind).toBe('Backoff')
  })

  it('a multibyte character cut between two chunks reaches the PUT intact', async () => {
    await start()
    h.server.getPolicy = () => ({ kind: 'stream' })
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    // Only a string the client sends back can show a corrupted decode: keys are
    // ASCII, and a broken character is just U+FFFD inside a JSON string.
    const connId = 'conn-\u00e9-\u{1f642}'
    const line = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        type: 'ready',
        connId,
        heartbeatMs: 20_000,
        accepted: [],
        rejected: [],
        deferred: [],
      }) + '\n',
      'utf8'
    )
    const eAt = line.indexOf(Buffer.from('\u00e9', 'utf8'))
    const emojiAt = line.indexOf(Buffer.from('\u{1f642}', 'utf8'))
    // Inside the 2-byte é, then between the 2nd and 3rd byte of the 4-byte emoji.
    for (const [from, to] of [
      [0, eAt + 1],
      [eAt + 1, emojiAt + 2],
      [emojiAt + 2, line.length],
    ] as const) {
      h.server.write(line.subarray(from, to))
      await h.settle()
    }
    expect(linkOf().kind).toBe('Ready')
    await h.subscribe([A])
    expect(h.server.putBodies.map(b => (JSON.parse(b) as { connId: string }).connId)).toEqual([
      connId,
    ])
  })

  it('blank lines are skipped; a ready with heartbeatMs outside [5 s, 25 s] is a transient failure', async () => {
    await start()
    h.server.write('\n\n')
    await h.settle()
    expect(linkOf().kind).toBe('Ready')
    h.server.getPolicy = rec =>
      rec.n === 2 ? { kind: 'ready', heartbeatMs: 30_000 } : { kind: 'ready' }
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    expect(gets()).toHaveLength(2)
    expect(linkOf().kind).toBe('Backoff')
    await fire(linkOf().timer)
    expect(linkOf().kind).toBe('Ready')
  })

  it('a 400 on the open empties sent until the merged list changes', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec =>
      rec.n === 1
        ? { kind: 'hold' }
        : rec.n === 2
          ? { kind: 'error', status: 400, code: 'bad_request' }
          : { kind: 'ready' }
    await h.login()
    await h.subscribe([A, B])
    h.server.eof()
    // the held GET carried no keys; force a reopen that carries [A, B]
    h.client.onEnvSwitchStart()
    h.client.onEnvSwitchEnd(false)
    await h.settle()
    expect(gets()[1]!.keys).toEqual([A, B])
    expect(st().sent).toEqual([])
    await fire(linkOf().timer)
    expect(gets()[2]!.keys).toEqual([])
    await h.subscribe([A, B])
    expect(puts()).toHaveLength(0)
    await h.subscribe([A, B, C])
    expect(puts().at(-1)!.keys).toEqual([A, B, C])
  })

  it('T-CB23: roots_changed reaches the renderer; an unknown frame does not feed the watchdog', async () => {
    await start({ keys: [] })
    h.server.frame({ type: 'roots_changed' })
    await h.settle()
    expect(h.owner().ofType('accessChangedRoots')).toHaveLength(1)
    await h.advance(30_000)
    h.server.frame({ type: 'brand_new_frame' })
    await h.settle()
    await h.advance(30_000)
    expect(linkOf().kind).toBe('Backoff')
  })

  it('T-CB58: a 2xx without body backs off; a throwing frame handler closes the link in the same tick', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec => (rec.n === 1 ? { kind: 'noBody', status: 204 } : { kind: 'ready' })
    await h.login()
    expect(linkOf().kind).toBe('Backoff')
    await fire(linkOf().timer)
    expect(linkOf().kind).toBe('Ready')
    // The heartbeat handler re-arms the watchdog; making that throw fails the handler mid-transition.
    h.clock.failNext = true
    h.server.frame({ type: 'heartbeat' })
    await h.settle()
    expect(linkOf().kind).toBe('Backoff')
    expect(h.logs.some(l => l.message === 'watch frame handler failed')).toBe(true)
  })

  it('T-CB52: an unknown closing reason backs off and reopens; a GET resolving for an old link has its body cancelled', async () => {
    await start()
    h.server.frame({ type: 'stream.closing', reason: 'otro' })
    await h.settle()
    expect(linkOf().kind).toBe('Backoff')
    await fire(linkOf().timer)
    expect(gets()).toHaveLength(2)
    await h.stop()

    // A fetch that ignores the abort and answers late: the response belongs to
    // an older link, so the client cancels its body and does not change state.
    const { createGfsWatchClient } = await import('./watchClient.js')
    const server = new FakeWatchServer()
    await server.start()
    let release!: (r: Response) => void
    let cancelled = false
    const late = new Promise<Response>(resolve => (release = resolve))
    let n = 0
    const client = createGfsWatchClient({
      baseUrl: () => server.baseUrl,
      fetch: () => (++n === 1 ? late : new Promise<Response>(() => {})),
      clock: new (await import('../../testSupport/gfsWatch/virtualClock.js')).VirtualClock(),
      readHopDepth: () => 0,
      onSessionExpiredVerdict: () => {},
      log: { warn: () => {}, error: () => {} },
    })
    client.onSessionToken(new WatchHarness().token(USER_A))
    client.onSessionToken(new WatchHarness().token(USER_B))
    const before = client.inspect().link
    release(
      new Response(new ReadableStream({ cancel: () => void (cancelled = true) }), { status: 200 })
    )
    await new Promise(r => setTimeout(r, 20))
    expect(cancelled).toBe(true)
    expect(client.inspect().link).toBe(before)
    client.dispose()
    await server.stop()
    h = await new WatchHarness().start()
  })
})

describe('access events', () => {
  it('T-CB18: a reopen after reauthorize with every key deferred resyncs all of them', async () => {
    await start({ keys: [A, B] })
    h.server.getPolicy = () => ({
      kind: 'ready',
      decide: keys => ({ accepted: [], rejected: [], deferred: keys, retryAfterMs: 3_000 }),
    })
    const access = () => h.owner().ofType('accessChanged').length
    const a0 = access()
    h.server.frame({ type: 'stream.closing', reason: 'reauthorize', retryAfterMs: 2_000 })
    await h.settle()
    expect(access()).toBe(a0 + 1)
    const mark = h.owner().events.length
    await fire(linkOf().timer)
    expect(access()).toBe(a0 + 2)
    expect(h.owner().events.slice(mark)).toContainEqual({ type: 'resync', keys: [A, B] })
    expect(h.isPending(st().deferredTimer)).toBe(true)
  })

  it('T-CB19: a revoked operator link: reauthorize refreshes access at once, the 403 reopen invalidates again and rejects sent', async () => {
    await start({ keys: [A] })
    const access = () => h.owner().ofType('accessChanged').length
    const a0 = access()
    h.server.getPolicy = () => ({ kind: 'error', status: 403, code: 'gfs_operator_link_invalid' })
    h.server.frame({ type: 'stream.closing', reason: 'reauthorize' })
    await h.settle()
    expect(access()).toBe(a0 + 1)
    await fire(linkOf().timer)
    expect(access()).toBe(a0 + 2)
    expect(h.owner().ofType('rejected').at(-1)).toEqual({ type: 'rejected', keys: [A] })
  })

  it('T-CB20: 503 watch_reauthorize on the open refreshes access before its backoff; listener_lost refreshes once on the next ready', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec =>
      rec.n === 1
        ? { kind: 'error', status: 503, code: 'watch_reauthorize', retryAfter: '2' }
        : { kind: 'ready' }
    await h.login()
    const owner = h.owner()
    h.client.setSubscriptions(owner, { keys: [], userId: USER_A }, owner.frameToken)
    await h.settle()
    // the owner registered after the 503: its accessChanged arrives with the ready
    await fire(linkOf().timer)
    const a = owner.ofType('accessChanged').length
    expect(a).toBe(1)
    h.server.frame({ type: 'stream.closing', reason: 'listener_lost' })
    await h.settle()
    expect(owner.ofType('accessChanged').length).toBe(a)
    await fire(linkOf().timer)
    expect(owner.ofType('accessChanged').length).toBe(a + 1)
  })

  it('T-CB53: the first ready of a session and every reopen from Backoff refresh access', async () => {
    h = await new WatchHarness().start()
    const owner = h.owner()
    // The window mounts before the session exists, as at startup.
    h.client.setSubscriptions(owner, { keys: [], userId: null }, owner.frameToken)
    await h.login()
    expect(owner.ofType('accessChanged')).toHaveLength(1)
    h.server.destroyStream()
    await h.settle()
    await fire(linkOf().timer)
    expect(owner.ofType('accessChanged')).toHaveLength(2)
  })
})

describe('PUT retries', () => {
  it('T-CB25/T-CB35: a PUT without answer is retried after T_put with the same seq: two requests, never three', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'hold' })
    await h.subscribe([A])
    expect(handle(st().put!.tPut).ms).toBe(T_PUT_MS)
    await fire(st().put!.tPut)
    expect(st().put?.phase).toBe('retry')
    await h.until(() => puts()[0]!.closed)
    await fire(st().put!.retryTimer)
    expect(puts().map(p => p.seq)).toEqual([1, 1])
    expect(h.maxPutsInFlight).toBe(1)
    h.server.answerPut(openPut(), { kind: 'accept' })
    await h.settle()
    expect(st().put).toBeNull()
    expect(puts()).toHaveLength(2)
  })

  it('T-CB29: a healthy stream survives a short app-wide request timeout; a hung PUT still aborts at T_put', async () => {
    const saved = config.requestTimeoutMs
    config.requestTimeoutMs = 100
    try {
      await start()
      await new Promise(r => setTimeout(r, 400))
      await h.advance(600_000, { heartbeats: true })
      expect(gets()).toHaveLength(1)
      expect(h.server.openStreams()).toHaveLength(1)
      h.server.putPolicy = () => ({ kind: 'hold' })
      await h.subscribe([A])
      await new Promise(r => setTimeout(r, 400))
      // requestJson got T_put + 1 s, so the 100 ms app-wide timeout did not abort it.
      expect(puts()[0]!.closed).toBe(false)
      await fire(st().put!.tPut)
      await h.until(() => puts()[0]!.closed)
    } finally {
      config.requestTimeoutMs = saved
    }
  })

  it('T-CB41: with a short app-wide timeout a hung server gets two requests with one seq; any 2xx body acks', async () => {
    const saved = config.requestTimeoutMs
    config.requestTimeoutMs = 50
    try {
      await start()
      h.server.putPolicy = () => ({ kind: 'hold' })
      await h.subscribe([A])
      await new Promise(r => setTimeout(r, 300))
      await h.fireNext()
      await h.fireNext()
      await new Promise(r => setTimeout(r, 300))
      await h.settle()
      expect(puts().map(p => p.seq)).toEqual([1, 1])
    } finally {
      config.requestTimeoutMs = saved
    }
    await h.stop()
    for (const raw of [
      { status: 200, body: '' },
      { status: 204, body: '' },
      { status: 202, body: 'accepted', contentType: 'text/plain' },
      { status: 200, body: '{"seq":1}', contentType: 'application/json' },
    ]) {
      await start()
      h.server.putPolicy = () => ({ kind: 'raw', ...raw })
      await h.subscribe([A])
      expect(st().put?.phase).toBe('acked')
      expect(puts()).toHaveLength(1)
      await h.stop()
    }
    h = await new WatchHarness().start()
  })

  it('T-CB40: a persistent 404 is replaced when sent changes, and reopens after the ceiling', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'error', status: 404 })
    await h.subscribe([A])
    await h.subscribe([B])
    await fire(st().put!.retryTimer)
    expect(puts().map(p => [p.seq, p.keys])).toEqual([
      [1, [A]],
      [2, [B]],
    ])
    while (st().put) await fire(st().put!.retryTimer)
    expect(puts().filter(p => p.seq === 2)).toHaveLength(PUT_MAX_ATTEMPTS)
    expect(linkOf().kind).toBe('Backoff')
    await fire(linkOf().timer)
    expect(gets().at(-1)!.keys).toEqual([B])
  })

  it('T-CB43: the ceiling holds even when sent changes before every retry', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'error', status: 404 })
    await h.subscribe([A])
    let i = 0
    while (st().put && i < 20) {
      await h.subscribe([i % 2 ? A : B, key('file', 100 + i)])
      i += 1
      await fire(st().put!.retryTimer)
    }
    expect(puts()).toHaveLength(PUT_MAX_ATTEMPTS + 1)
    expect(linkOf().kind).toBe('Backoff')
    const sentNow = [...st().sent]
    await fire(linkOf().timer)
    expect(gets().at(-1)!.keys).toEqual(sentNow)
  })

  it('T-CB44: an episode that ends without a new PUT resets the retry count', async () => {
    await start({ keys: [A] })
    h.server.putPolicy = () => ({ kind: 'error', status: 404 })
    await h.subscribe([A, B])
    for (let r = 0; r < 4; r++) await fire(st().put!.retryTimer)
    expect(st().putAttempt).toBe(5)
    await h.subscribe([A])
    await fire(st().put!.retryTimer)
    expect(st().put).toBeNull()
    expect(st().putAttempt).toBe(0)
    await h.subscribe([A, C])
    const first = handle(st().put!.retryTimer).ms
    expect(first).toBeGreaterThanOrEqual(1_000)
    expect(first).toBeLessThanOrEqual(1_200)
    const before = puts().length - 1
    while (st().put) await fire(st().put!.retryTimer)
    expect(puts().length - before).toBe(PUT_MAX_ATTEMPTS + 1)
  })

  it('T-CB57: a 429 Retry-After is honoured in seconds and as an HTTP-date; an invalid one falls back to the base', async () => {
    for (const [ra, floor] of [
      ['30', 30_000],
      ['date', 20_000],
      ['bogus', 1_000],
    ] as const) {
      await start()
      h.server.putPolicy = () => ({
        kind: 'error',
        status: 429,
        code: 'rate_limited',
        retryAfter: ra === 'date' ? new Date(h.clock.now() + 20_000).toUTCString() : ra,
      })
      await h.subscribe([A])
      const ms = handle(st().put!.retryTimer).ms
      expect(ms).toBeGreaterThanOrEqual(floor)
      expect(ms).toBeLessThanOrEqual(floor * 1.2)
      await h.stop()
    }
    h = await new WatchHarness().start()
  })

  it('T-CB9: a PUT retry never touches the connection that replaced its own; a 401 with a newer session resends with the new token', async () => {
    await start()
    h.server.putPolicy = rec => (rec.n === 1 ? { kind: 'error', status: 503 } : { kind: 'accept' })
    await h.subscribe([A])
    expect(st().put?.phase).toBe('retry')
    const retry = st().put!.retryTimer
    h.server.frame({ type: 'stream.closing', reason: 'reauthorize' })
    await h.settle()
    expect(h.isPending(retry)).toBe(false)
    await fire(linkOf().timer)
    await h.advance(30_000)
    expect(puts()).toHaveLength(1)
    expect(gets().at(-1)!.keys).toEqual([A])

    h.server.putPolicy = () => ({ kind: 'hold' })
    await h.subscribe([A, B])
    const refreshed = h.token(USER_A, 1)
    await h.publish(refreshed)
    h.server.putPolicy = () => ({ kind: 'accept' })
    h.server.answerPut(openPut(), { kind: 'error', status: 401, code: 'session_invalid' })
    await h.settle()
    expect(puts().at(-1)!.token).toBe(refreshed)
    expect(puts().at(-1)!.seq).toBe(2)
    expect(h.owner().ofType('sessionExpired')).toEqual([])
    expect(st().latch).toBeNull()
  })

  it('T-CB39: closing the link with a PUT in flight aborts it and reopens; a subscriptions before the 202 never leaves two PUTs open', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'hold' })
    await h.subscribe([A])
    expect(st().put?.phase).toBe('sending')
    h.client.onSessionToken(h.token(USER_B))
    expect(st().put).toBeNull()
    expect(linkOf().kind).toBe('Opening')
    await h.settle()
    await h.until(() => puts()[0]!.closed)
    expect(gets()).toHaveLength(2)

    await h.subscribe([B])
    const first = openPut()
    await h.subscribe([B, C])
    // The owner applies the command and its frame overtakes the 202.
    h.server.applyCommand(first)
    await h.settle()
    expect(h.maxPutsInFlight).toBe(1)
    expect(puts().at(-1)!.keys).toEqual([B, C])
    expect(st().put?.seq).toBe(2)
  })

  it('T-CB42: a deferred key that leaves sent and comes back is retried', async () => {
    await start({ keys: [A] })
    h.server.getPolicy = () => ({
      kind: 'ready',
      decide: keys => ({ accepted: [], rejected: [], deferred: keys, retryAfterMs: 2_000 }),
    })
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    expect(h.isPending(st().deferredTimer)).toBe(true)
    await h.subscribe([])
    expect(puts()).toHaveLength(1)
    await fire(st().deferredTimer)
    expect(puts()).toHaveLength(1)
    await h.subscribe([A])
    const t = handle(st().deferredTimer)
    expect(h.isPending(t)).toBe(true)
    expect(t.ms).toBeLessThanOrEqual(2_400)
    await fire(t)
    expect(puts().at(-1)!.keys).toEqual([A])

    // Variant: sent changes while Opening, so the ready's deferred key is not in sent.
    h.server.getPolicy = () => ({ kind: 'hold' })
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    await h.subscribe([])
    h.server.answerGet(gets().at(-1)!, {
      kind: 'ready',
      decide: () => ({ accepted: [], rejected: [], deferred: [A], retryAfterMs: 2_000 }),
    })
    await h.settle()
    expect(st().deferredTimer).toBeNull()
    const n = puts().length
    await h.subscribe([A])
    await h.advance(2_400)
    expect(puts().length).toBe(n + 1)
    expect(puts().at(-1)!.keys).toEqual([A])
  })

  it('T-CB51: a PUT 400 does not poison the next link: its deferred key is retried there', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'error', status: 400, code: 'bad_request' })
    await h.subscribe([A])
    expect(st().poisonedPut).toEqual(new Set([A]))
    h.server.putPolicy = () => ({ kind: 'accept' })
    h.server.getPolicy = () => ({
      kind: 'ready',
      decide: keys => ({ accepted: [], rejected: [], deferred: keys }),
    })
    h.server.destroyStream()
    await h.settle()
    await fire(linkOf().timer)
    expect(h.isPending(st().deferredTimer)).toBe(true)
    await fire(st().deferredTimer)
    expect(puts().at(-1)!.keys).toEqual([A])
    expect(puts()).toHaveLength(2)
  })

  it('T-CB49: the seq restarts on every link, so the first PUT of a new link lands inside the server window', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'accept' })
    const o = h.owner()
    for (let i = 0; i < 1_100; i++) {
      h.client.setSubscriptions(
        o,
        { keys: [key('file', 1 + (i % 2))], userId: USER_A },
        o.frameToken
      )
      await h.until(() => st().put === null)
    }
    expect(h.server.current()!.lastSeq).toBe(1_100)
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    await h.subscribe([C])
    expect(puts().at(-1)!.seq).toBe(1)
    expect(st().put).toBeNull()
    expect([...h.server.current()!.keys]).toEqual([C])
  }, 60_000)
})

describe('session, binding and latch', () => {
  it('T-CB21: after logout of A the first GET of B carries no keys; an environment switch drops the old keys', async () => {
    await start({ keys: [A, B] })
    await h.publish(null)
    expect(linkOf().kind).toBe('Idle')
    await h.login(USER_B)
    expect(gets().at(-1)!.keys).toEqual([])
    await h.subscribe([C])
    const old = h.server
    const fresh = new FakeWatchServer()
    await fresh.start()
    h.client.onEnvSwitchStart()
    h.server = fresh
    h.client.onEnvSwitchEnd(true)
    await h.settle()
    // The old environment's token never reaches the new one.
    expect(fresh.gets).toHaveLength(0)
    expect(st().session?.token).toBeNull()
    await h.login(USER_B)
    expect(fresh.gets).toHaveLength(1)
    expect(fresh.gets[0]!.keys).toEqual([])
    await old.stop()
  })

  it('a switch to another environment without a new token opens nothing', async () => {
    await start({ keys: [A] })
    await h.until(() => h.linkKind() === 'Ready')
    h.client.onEnvSwitchStart()
    h.client.onEnvSwitchEnd(true)
    await h.advance(600_000)
    expect(gets()).toHaveLength(1)
    expect(linkOf().kind).toBe('Idle')
    await h.until(() => h.server.openStreams().length === 0)
  })

  it('T-CB12: an environment switch that changes nothing, started from Backoff, ends with one stream', async () => {
    await start({ keys: [A] })
    h.server.eof()
    await h.settle()
    const backoff = linkOf().timer
    h.client.onEnvSwitchStart()
    expect(h.isPending(backoff)).toBe(false)
    expect(linkOf().kind).toBe('Idle')
    h.client.onEnvSwitchEnd(false)
    await h.settle()
    expect(h.server.openStreams()).toHaveLength(1)
    expect(gets().at(-1)!.keys).toEqual([A])
  })

  it('T-CB61/T-CB62: a new token with the same binding (refresh, team switch, hop restore) keeps the stream; another user or generation reopens', async () => {
    await start({ keys: [A] })
    const access = () => h.owner().ofType('accessChanged').length
    const a0 = access()
    for (const team of [TEAM_1, TEAM_2, null]) {
      await h.publish(h.token(USER_A, 1, team))
      h.client.onStopAllStreams()
      await h.settle()
    }
    expect(gets()).toHaveLength(1)
    expect(access()).toBe(a0)
    const switched = h.token(USER_A, 1, TEAM_2)
    await h.publish(switched)
    h.client.onStopAllStreams()
    await h.subscribe([A, B])
    expect(puts().at(-1)!.token).toBe(switched)

    await h.publish(h.token(USER_A, 2))
    expect(gets()).toHaveLength(2)
    await h.publish(h.token(USER_B, 2))
    expect(gets()).toHaveLength(3)
    expect(gets().at(-1)!.keys).toEqual([])
    await h.publish('opaque-session-token')
    expect(gets()).toHaveLength(4)
    expect(st().session?.binding).toBeNull()
    const r = await h.subscribe([A], 1, USER_B)
    expect(r.sessionExpired).toBe(false)
    expect(st().sent).toEqual([])
  })

  it('T-CB54: the open error rows are chosen by code; a response for a link replaced in the same tick is dropped', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = () => ({ kind: 'error', status: 403, code: 'desktop_user_retired' })
    await h.login()
    expect(st().latch).not.toBeNull()
    expect(linkOf().kind).toBe('Idle')
    await h.stop()

    h = await new WatchHarness().start()
    h.server.getPolicy = () => ({ kind: 'error', status: 403 })
    await h.login()
    expect(st().latch).toBeNull()
    expect(backoffMs()).toBeGreaterThanOrEqual(60_000)
    await h.stop()

    h = await new WatchHarness().start()
    h.owner()
    h.client.setSubscriptions(h.owner(), { keys: [], userId: null }, h.owner().frameToken)
    h.server.getPolicy = rec =>
      rec.n === 1
        ? { kind: 'error', status: 503, code: 'watch_reauthorize', retryAfter: '3' }
        : { kind: 'ready' }
    await h.login()
    expect(h.owner().ofType('accessChanged')).toHaveLength(1)
    expect(backoffMs()).toBeGreaterThanOrEqual(3_000)
    await h.stop()

    h = await new WatchHarness().start()
    h.server.getPolicy = rec =>
      rec.n === 1 ? { kind: 'error', status: 403, code: 'desktop_user_retired' } : { kind: 'ready' }
    h.beforeGetResponse = () => h.client.onSessionToken(h.token(USER_B))
    await h.login()
    await h.settle()
    expect(st().latch).toBeNull()
    expect(h.verdicts).toBe(0)
    expect(linkOf().kind).toBe('Ready')
    expect(gets()).toHaveLength(2)
  })

  it('a 401 on the open with a newer session reopens with it instead of expiring', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec => (rec.n === 1 ? { kind: 'hold' } : { kind: 'ready' })
    await h.login()
    await h.subscribe([])
    const refreshed = h.token(USER_A, 1)
    await h.publish(refreshed)
    h.server.answerGet(gets()[0]!, { kind: 'error', status: 401, code: 'session_invalid' })
    await h.settle()
    expect(h.owner().ofType('sessionExpired')).toEqual([])
    expect(st().latch).toBeNull()
    expect(gets().at(-1)!.token).toBe(refreshed)
    expect(linkOf().kind).toBe('Ready')
  })

  it('T-CB64 (watch side): every sessionExpired asks /me once; a newer session asks nothing', async () => {
    await start()
    const owner = h.owner()
    h.client.setSubscriptions(owner, { keys: [], userId: USER_A }, owner.frameToken)
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(owner.ofType('sessionExpired')).toHaveLength(1)
    expect(h.verdicts).toBe(1)
    expect(linkOf().kind).toBe('Idle')
    await h.advance(600_000)
    expect(gets()).toHaveLength(1)

    await h.login()
    expect(gets()).toHaveLength(2)
    h.server.getPolicy = () => ({ kind: 'error', status: 401, code: 'session_invalid' })
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    expect(h.verdicts).toBe(2)

    h.server.getPolicy = () => ({ kind: 'ready' })
    await h.login()
    const opened = gets().length
    // An expiry of the token the stream was opened with, after a newer one was published.
    h.beforeGetResponse = null
    const newer = h.token(USER_A, 1)
    h.client.onSessionToken(newer)
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(h.verdicts).toBe(2)
    expect(gets().length).toBe(opened + 1)
  })

  it('T-CB14 (watch side): an expiry inside the hop opens nothing until release, then expires once; a later window learns it from its answer', async () => {
    await start()
    const owner = h.owner()
    h.client.setSubscriptions(owner, { keys: [], userId: USER_A }, owner.frameToken)
    h.hopDepth = 1
    h.client.onHopEnter()
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(owner.ofType('sessionExpired')).toEqual([])
    expect(st().latch?.deferred).toBe(true)
    await h.advance(120_000)
    expect(gets()).toHaveLength(1)
    h.hopDepth = 0
    h.client.onHopRelease(h.appToken)
    h.client.onHopRelease(h.appToken)
    await h.settle()
    expect(owner.ofType('sessionExpired')).toHaveLength(1)
    expect(h.verdicts).toBe(1)
    h.client.ownerDestroyed(owner.id)
    const fresh = h.owner(2)
    expect(
      h.client.setSubscriptions(fresh, { keys: [A], userId: USER_A }, fresh.frameToken)
    ).toEqual({ sessionExpired: true })
    expect(gets()).toHaveLength(1)
  })

  it('T-CB65: 426 upgrade_required / 409 session_contract_unsupported stop the watch until a newer token', async () => {
    for (const [status, code, where] of [
      [426, 'upgrade_required', 'GET'],
      [409, 'session_contract_unsupported', 'GET'],
      [426, 'upgrade_required', 'PUT'],
      [409, 'session_contract_unsupported', 'PUT'],
    ] as const) {
      h = await new WatchHarness().start()
      if (where === 'GET')
        h.server.getPolicy = rec =>
          rec.n === 1 ? { kind: 'error', status, code } : { kind: 'ready' }
      else
        h.server.putPolicy = rec =>
          rec.n === 1 ? { kind: 'error', status, code } : { kind: 'accept' }
      const token = await h.login()
      if (where === 'PUT') await h.subscribe([A])
      expect(linkOf().kind).toBe('Idle')
      const n = gets().length
      await h.publish(token)
      await h.subscribe([A, B])
      await h.advance(600_000)
      expect(gets()).toHaveLength(n)
      expect(h.owner().ofType('sessionExpired')).toEqual([])
      await h.login()
      expect(gets()).toHaveLength(n + 1)
      await h.stop()
    }
    h = await new WatchHarness().start()
  })
})

describe('owners', () => {
  it('T-CB22 (watch side): every owner, with keys or not, gets sessionExpired; an IPC of the previous document is ignored', async () => {
    await start()
    await h.subscribe([A], 1)
    await h.subscribe([], 2)
    const one = h.owner(1)
    const stale = one.frameToken
    h.client.ownerNavigated(one.id, one.navigate())
    expect(st().sent).toEqual([])
    h.client.setSubscriptions(one, { keys: [B], userId: USER_A }, stale)
    expect(st().sent).toEqual([])
    await h.subscribe([C], 1)
    expect(st().sent).toEqual([C])
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(h.owner(1).ofType('sessionExpired')).toHaveLength(1)
    expect(h.owner(2).ofType('sessionExpired')).toHaveLength(1)
  })

  it('T-CB31 (watch side): a destroyed owner and a throwing owner do not stop delivery to the rest', async () => {
    await start()
    await h.subscribe([], 1)
    await h.subscribe([], 2)
    await h.subscribe([A], 3)
    h.owner(1).destroyed = true
    h.owner(2).throwOnSend = true
    h.server.frame({ type: 'changed', keys: [A] })
    await h.settle()
    expect(h.owner(3).ofType('changed')).toEqual([{ type: 'changed', keys: [A] }])
    expect(h.owner(1).events.filter(e => e.type === 'changed')).toEqual([])
  })

  it('owner lifecycle: crash refuses IPC until navigation, stop keeps the owner, destroy drops its keys and keeps the stream', async () => {
    await start()
    await h.subscribe([A], 1)
    await h.subscribe([B], 2)
    const one = h.owner(1)
    h.client.ownerProcessGone(one.id)
    expect(st().sent).toEqual([B])
    expect(h.client.setSubscriptions(one, { keys: [A], userId: USER_A }, one.frameToken)).toEqual({
      sessionExpired: false,
    })
    expect(st().sent).toEqual([B])
    h.client.ownerNavigated(one.id, one.navigate())
    await h.subscribe([A], 1)
    expect(st().sent).toEqual([A, B])
    h.client.stopOwner(one, one.frameToken)
    expect(st().sent).toEqual([B])
    await h.subscribe([D], 1)
    expect(st().owners.get(1)!.regOrder).toBe(1)
    h.client.ownerDestroyed(2)
    h.client.ownerDestroyed(1)
    await h.settle()
    expect(st().sent).toEqual([])
    expect(linkOf().kind).toBe('Ready')
    expect(h.server.openStreams()).toHaveLength(1)
  })
})

describe('second-round hardening', () => {
  it('426/409 for a token older than the session reopen with the current one (GET and PUT)', async () => {
    for (const where of ['GET', 'PUT'] as const) {
      for (const [status, code] of [
        [426, 'upgrade_required'],
        [409, 'session_contract_unsupported'],
      ] as const) {
        h = await new WatchHarness().start()
        if (where === 'GET') {
          h.server.getPolicy = rec => (rec.n === 1 ? { kind: 'hold' } : { kind: 'ready' })
          await h.login()
        } else {
          await h.login()
          h.server.putPolicy = () => ({ kind: 'hold' })
          await h.subscribe([A])
        }
        const refreshed = h.token(USER_A, 1)
        await h.publish(refreshed)
        const held = where === 'GET' ? null : openPut()
        h.server.putPolicy = () => ({ kind: 'accept' })
        if (where === 'GET') h.server.answerGet(gets()[0]!, { kind: 'error', status, code })
        else h.server.answerPut(held!, { kind: 'error', status, code })
        await h.settle()
        expect(st().unsupportedGeneration).toBeNull()
        expect(linkOf().kind).toBe('Ready')
        expect(gets().at(-1)!.token).toBe(refreshed)
        await h.stop()
      }
    }
    h = await new WatchHarness().start()
  })

  it('keys outside the canonical form are dropped from server frames; a list is cut at 64', async () => {
    await start()
    h.server.frame({ type: 'changed', keys: [A, 'FILE:gfs://d1/x', '../../etc'] })
    await h.settle()
    expect(h.owner().ofType('changed')).toEqual([])
    await h.subscribe([A])
    h.server.frame({ type: 'changed', keys: [A, 'not-a-key'] })
    await h.settle()
    expect(h.owner().ofType('changed')).toEqual([{ type: 'changed', keys: [A] }])
    h.server.getPolicy = () => ({
      kind: 'ready',
      decide: keys => ({ accepted: [...keys, 'bogus'], rejected: ['also bogus'], deferred: [] }),
    })
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    expect(h.owner().events.at(-2)).toEqual({ type: 'resync', keys: [A] })
    expect([...(linkOf().ackedKeys as Set<string>)]).toEqual([A])
    const many = Array.from({ length: 80 }, (_, i) => key('file', 0x100 + i))
    await h.subscribe(many)
    expect(st().owners.get(1)!.keys).toHaveLength(64)
  })

  it('the degradation ends with the ready: a later 403 refreshes access and rejects again', async () => {
    h = await new WatchHarness().start()
    h.server.getPolicy = rec => (rec.n === 2 ? { kind: 'ready' } : { kind: 'error', status: 403 })
    await h.login()
    await h.subscribe([A])
    const access = () => h.owner().ofType('accessChanged').length
    const rejected = () => h.owner().ofType('rejected').length
    await fire(linkOf().timer)
    expect(linkOf().kind).toBe('Ready')
    const [a0, r0] = [access(), rejected()]
    h.server.eof()
    await h.settle()
    await fire(linkOf().timer)
    expect(access()).toBe(a0 + 1)
    expect(rejected()).toBe(r0 + 1)
  })

  it('a deferred key in a subscriptions frame is resynced at once', async () => {
    await start()
    h.server.putPolicy = () => ({
      kind: 'accept',
      decide: keys => ({ accepted: [], rejected: [], deferred: keys, retryAfterMs: 2_000 }),
    })
    const mark = h.owner().events.length
    await h.subscribe([A])
    expect(h.owner().events.slice(mark)).toContainEqual({ type: 'resync', keys: [A] })
  })

  it('a PUT 403 other backs off slowly', async () => {
    await start()
    h.server.putPolicy = () => ({ kind: 'error', status: 403, code: 'gfs_operator_link_invalid' })
    await h.subscribe([A])
    expect(backoffMs()).toBeGreaterThanOrEqual(60_000)
  })

  it('closing the link leaves no timer of the old link or its PUT pending', async () => {
    await start({ keys: [A] })
    h.server.putPolicy = () => ({
      kind: 'accept',
      decide: keys => ({
        accepted: [A],
        rejected: [],
        deferred: keys.filter(k => k !== A),
        retryAfterMs: 2_000,
      }),
    })
    await h.subscribe([A, B])
    expect(h.isPending(st().deferredTimer)).toBe(true)
    h.server.putPolicy = () => ({ kind: 'hold' })
    await h.subscribe([A, B, C])
    expect(st().put?.phase).toBe('sending')
    h.server.eof()
    await h.settle()
    expect(h.clock.pending()).toEqual([handle(linkOf().timer)])
  })
})

describe('closing the link never leaks a rejection', () => {
  it('T-CB46: closeLink from Ready by binding, logout, env, listener_lost, ack_timeout and watchdog', async () => {
    await start({ keys: [A] })
    const reopen = async () => {
      if (linkOf().kind === 'Backoff') await fire(linkOf().timer)
      expect(linkOf().kind).toBe('Ready')
    }
    await h.login(USER_B)
    await reopen()
    await h.publish(null)
    await h.login(USER_A)
    await reopen()
    h.client.onEnvSwitchStart()
    h.client.onEnvSwitchEnd(false)
    await h.settle()
    await reopen()
    h.server.frame({ type: 'stream.closing', reason: 'listener_lost' })
    await h.settle()
    await reopen()
    h.server.putPolicy = () => ({ kind: 'accept', frame: false })
    await h.subscribe([B])
    await fire(st().put!.tAck)
    await reopen()
    await fire(linkOf().watchdog)
    await reopen()
    await new Promise(r => setTimeout(r, 30))
    expect(h.unhandled).toEqual([])
    expect(h.logs.filter(l => l.level === 'error')).toEqual([])
  })
})
