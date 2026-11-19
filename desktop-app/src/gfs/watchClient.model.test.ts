import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { FakeOwner } from '../../testSupport/gfsWatch/fakeOwner.js'
import type { Decision } from '../../testSupport/gfsWatch/fakeWatchServer.js'
import { type MConn, MemoryWatch } from '../../testSupport/gfsWatch/memoryWatch.js'
import {
  USER_A,
  USER_B,
  key,
  signV1SessionToken,
} from '../../testSupport/gfsWatch/sessionTokens.js'
import {
  VirtualClock,
  type VirtualTimer,
  seededRandom,
} from '../../testSupport/gfsWatch/virtualClock.js'
import { type GfsWatchClient, createGfsWatchClient } from './watchClient.js'

/**
 * Model-based oracle of the main-process watch client.
 *
 * `fc.commands` drives the events main receives (renderer lists and owner
 * lifecycle, token publications with and without `stopAllStreams` in the same
 * tick, team hops, environment switches, every answer of the GET and the PUT,
 * every frame, timers), and `fc.scheduler()` decides the order in which
 * responses and frames reach the client. The client is the real one, with the
 * real `requestJson` and stream reader; only the network is in memory.
 *
 * After every command the safety invariants are checked; at the end the
 * network is made healthy, everything is drained, and the invariants at rest
 * are checked against a trivial reference model that knows only what the
 * test did: owners, their documents and lists, tokens and hops, and which
 * responses reached a request the client had not aborted (a 400 on the open
 * empties `sent` until the merge changes; a 400 on a PUT leaves that exact set
 * unsent on that link). It never reads those flags from the client.
 */

const KEYS = [key('file', 1), key('file', 2), key('dir', 3), key('dir', 4), key('file', 5)]
const RUNS = Number(process.env.GFS_WATCH_MODEL_RUNS ?? 300)
// Fixed by default so CI explores the same sequences; override to search further.
const SEED = Number(process.env.GFS_WATCH_MODEL_SEED ?? 20261113)

type RefOwner = { id: number; regOrder: number | null; doc: string | null; keys: string[] }

function refFuse(owners: RefOwner[]): string[] {
  const reg = owners.filter(o => o.regOrder !== null).sort((a, b) => a.regOrder! - b.regOrder!)
  const out: string[] = []
  for (let i = 0; i < 64; i++)
    for (const o of reg) if (o.keys[i] && !out.includes(o.keys[i]!)) out.push(o.keys[i]!)
  return out.slice(0, 64)
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>(r => setImmediate(r))
}

class System {
  clock = new VirtualClock()
  net: MemoryWatch
  client: GfsWatchClient
  violations: string[] = []
  slots: FakeOwner[] = []
  ref = {
    owners: new Map<number, RefOwner>(),
    regCounter: 0,
    token: null as string | null,
    user: null as string | null,
    generation: 0,
    appToken: null as string | null,
    authGen: 1,
    hop: 0,
    env: false,
    /** The open's 400 reached the current GET and the merge has not changed since. */
    empty: false,
    lastFuse: [] as string[],
    /** The last PUT 400 on a link, with its exact key set. */
    poison: null as { connId: string; keys: Set<string> } | null,
    /** A retryable PUT failure just reached the current attempt. */
    retryAfter: null as { connId: string; label: string } | null,
  }
  /** Every event delivered to any owner, with the link generation it was emitted under. */
  events: Array<{ type: string; keys?: string[]; g: number | undefined }> = []
  /** Index in `events` where the current link's ready started emitting. */
  readyMark = new Map<number, number>()
  private nextOwnerId = 1
  private opaque = 0

  constructor(
    readonly s: fc.Scheduler,
    seed: number
  ) {
    this.net = new MemoryWatch(s)
    this.client = createGfsWatchClient({
      baseUrl: () => 'http://watch.test',
      fetch: this.net.fetch as typeof fetch,
      clock: this.clock,
      random: seededRandom(seed),
      log: { warn: () => {}, error: () => {} },
      readHopDepth: () => this.ref.hop,
      onSessionExpiredVerdict: () => {},
    })
    this.net.onDeliver = d => {
      if (d.kind === 'get' && d.status === 400 && d.rec === this.net.gets.at(-1))
        this.ref.empty = true
      if (d.kind === 'put' && d.status === 400)
        this.ref.poison = { connId: d.rec.connId, keys: new Set(d.rec.keys) }
      const retryable =
        d.status === 'network' ||
        d.status === 404 ||
        d.status === 429 ||
        (typeof d.status === 'number' && d.status >= 500)
      if (d.kind === 'put' && retryable)
        this.ref.retryAfter = { connId: d.rec.connId, label: this.net.lastDelivered }
    }
    this.net.onPutRequest = () => {
      this.ref.poison = null
      this.ref.retryAfter = null
    }
    for (let i = 0; i < 3; i++) this.slots.push(this.newOwner())
  }

  /** The client re-merges synchronously at the same points; mirror its reset of the 400 row. */
  private syncRefFuse(): void {
    const f = refFuse([...this.ref.owners.values()])
    if (JSON.stringify(f) !== JSON.stringify(this.ref.lastFuse)) {
      this.ref.lastFuse = f
      this.ref.empty = false
    }
  }

  /** What `sent` must be, from the reference alone. */
  expectedSent(): string[] {
    return this.ref.empty ? [] : refFuse([...this.ref.owners.values()])
  }

  private newOwner(): FakeOwner {
    const o = new FakeOwner(this.nextOwnerId++)
    const send = o.send.bind(o)
    o.send = ev => {
      if (ev.type === 'sessionExpired') this.checkExpiry()
      this.recordEvent(ev)
      send(ev)
    }
    this.ref.owners.set(o.id, { id: o.id, regOrder: null, doc: o.frameToken, keys: [] })
    return o
  }

  /** Expiries for an older token that the spec accepts: a retired user (F-28, MC-M6). */
  retiredOldExpiry = 0
  expiries = 0
  private lastDeliveredEvent: unknown = null

  /**
   * Every event reaches every registered owner, so one record per emission.
   * The first emission under a new Ready generation opens that ready's batch,
   * which must carry `accessChanged`: every open refreshes access.
   */
  private recordEvent(ev: { type: string; keys?: string[] }): void {
    if (ev === this.lastDeliveredEvent) return
    this.lastDeliveredEvent = ev
    const link = this.client.inspect().link as { kind: string; g?: number }
    const g = link.kind === 'Ready' ? link.g : undefined
    if (g !== undefined && !this.readyMark.has(g)) {
      const mark = this.events.length
      this.readyMark.set(g, mark)
      queueMicrotask(() => {
        if (!this.events.slice(mark).some(e => e.g === g && e.type === 'accessChanged')) {
          this.violations.push(`ready g=${g} without accessChanged`)
        }
      })
    }
    this.events.push({ type: ev.type, keys: ev.keys, g })
  }

  /**
   * A purge only for the current session, never for an older token. The one
   * accepted exception is the 403 `desktop_user_retired` row, which has no
   * newer-session gate: the user itself is retired, whatever the token.
   */
  private checkExpiry(): void {
    this.expiries += 1
    const latch = this.client.inspect().latch
    if (!latch || latch.deferred) this.violations.push('sessionExpired without an active latch')
    else if (latch.generation < this.ref.generation) {
      if (/ 403 desktop_user_retired$/.test(this.net.lastDelivered)) this.retiredOldExpiry += 1
      else this.violations.push(`sessionExpired for an older token after ${this.net.lastDelivered}`)
    }
  }

  // ── events ──
  publish(
    kind: 'refresh' | 'otherGen' | 'otherUser' | 'logout' | 'opaque' | 'login',
    withStop: boolean
  ): void {
    let token: string | null
    let user = this.ref.user
    if (kind === 'logout') {
      token = null
      user = null
    } else if (kind === 'opaque') {
      token = `opaque-${++this.opaque}`
      user = null
    } else {
      if (kind === 'otherUser' || user === null) user = user === USER_A ? USER_B : USER_A
      if (kind === 'otherGen') this.ref.authGen += 1
      token = signV1SessionToken({ userId: user, authGeneration: this.ref.authGen })
    }
    this.applyRefToken(token, user)
    this.ref.appToken = token
    this.client.onSessionToken(token)
    if (withStop) this.client.onStopAllStreams()
    this.syncRefFuse()
  }

  private applyRefToken(token: string | null, user: string | null): void {
    if (token !== this.ref.token) this.ref.generation += 1
    const userChanged = this.ref.user === null || user === null || this.ref.user !== user
    this.ref.token = token
    this.ref.user = user
    if (token === null || userChanged) this.clearRefLists()
  }

  private clearRefLists(): void {
    for (const o of this.ref.owners.values()) o.keys = []
    this.ref.empty = false
    this.ref.lastFuse = []
    this.ref.poison = null
  }

  setList(slot: number, keys: string[], stale: 'none' | 'user' | 'doc'): void {
    const o = this.slots[slot]!
    const r = this.ref.owners.get(o.id)!
    const userId = stale === 'user' ? (this.ref.user === USER_A ? USER_B : USER_A) : this.ref.user
    const frame = stale === 'doc' ? `${o.frameToken}-old` : o.frameToken
    if (r.regOrder === null && !o.destroyed) {
      r.regOrder = ++this.ref.regCounter
      r.doc = o.frameToken
    }
    if (!o.destroyed && frame !== null && frame === r.doc) {
      r.keys = this.ref.user !== null && userId === this.ref.user ? [...new Set(keys)] : []
    }
    this.client.setSubscriptions(o, { keys, userId }, frame)
    this.syncRefFuse()
  }

  ownerEvent(slot: number, ev: 'navigate' | 'gone' | 'stop' | 'destroy'): void {
    const o = this.slots[slot]!
    const r = this.ref.owners.get(o.id)!
    if (ev === 'navigate') {
      if (r.regOrder !== null) {
        r.keys = []
        r.doc = o.navigate()
      } else o.navigate()
      this.client.ownerNavigated(o.id, o.frameToken)
    } else if (ev === 'gone') {
      if (r.regOrder !== null) {
        r.keys = []
        r.doc = null
      }
      this.client.ownerProcessGone(o.id)
    } else if (ev === 'stop') {
      if (r.regOrder !== null && r.doc !== null && r.doc === o.frameToken) r.keys = []
      this.client.stopOwner(o, o.frameToken)
    } else {
      o.destroyed = true
      this.ref.owners.delete(o.id)
      this.client.ownerDestroyed(o.id)
      this.syncRefFuse()
      // A replacement window mounts at once, as main recreates it.
      this.slots[slot] = this.newOwner()
      this.setList(slot, [], 'none')
    }
    this.syncRefFuse()
  }

  hop(enter: boolean, commitUnpublished: boolean): void {
    if (enter) {
      this.ref.hop += 1
      this.client.onHopEnter()
      if (commitUnpublished && this.ref.user) {
        // A hop without restore commits its own token without publishing it.
        this.ref.appToken = signV1SessionToken({
          userId: this.ref.user,
          authGeneration: this.ref.authGen,
        })
      }
      return
    }
    if (this.ref.hop === 0) return
    this.ref.hop -= 1
    if (this.ref.hop === 0 && this.ref.appToken !== this.ref.token)
      this.applyRefToken(this.ref.appToken, this.ref.user)
    this.client.onHopRelease(this.ref.appToken)
    this.syncRefFuse()
  }

  env(start: boolean, changed: boolean): void {
    if (start) {
      this.ref.env = true
      this.client.onEnvSwitchStart()
    } else {
      if (!this.ref.env) return
      this.ref.env = false
      if (changed) {
        // The client drops the old environment's session: a new one must be published.
        this.applyRefToken(null, null)
        this.ref.appToken = null
        this.clearRefLists()
      }
      this.client.onEnvSwitchEnd(changed)
      this.syncRefFuse()
    }
  }

  /** `progress` fires only timers that move a waiting state forward (backoff, deferred, PUT retry). */
  fireNext(kind: string): void {
    const s = this.client.inspect()
    const link = s.link as { kind: string; timer?: unknown }
    const progress = [
      link.kind === 'Backoff' ? link.timer : null,
      s.deferredTimer,
      s.put?.retryTimer ?? null,
    ]
    const t = this.clock.pending().find(x => kind === 'any' || progress.includes(x))
    if (t) this.clock.fire(t)
  }

  currentConn(): MConn | undefined {
    const link = this.client.inspect().link as { kind: string; connId?: string }
    return (
      this.net.conns.find(c => c.connId === link.connId && c.alive) ?? this.net.liveConns().at(-1)
    )
  }

  // ── invariants ──
  checkSafety(where: string): void {
    const s = this.client.inspect()
    const v = (m: string) => this.violations.push(`${where}: ${m}`)
    if (this.net.putsInFlight().length > 1)
      v(`I34: ${this.net.putsInFlight().length} PUTs in flight`)
    const p = s.put
    if (p?.phase === 'sending' && !this.clock.isPending(p.tPut)) v('I34: sending without tPut')
    if (p?.phase === 'retry' && !this.clock.isPending(p.retryTimer))
      v('I34: retry without retryTimer')
    if (p?.phase === 'acked' && !this.clock.isPending(p.tAck)) v('I34: acked without tAck')
    if (p && s.link.kind !== 'Ready') v('I34: put outside Ready')
    if (this.net.liveGets().length > 1) v(`I18: ${this.net.liveGets().length} GETs alive`)
    const link = s.link as { kind: string; connId?: string; g?: number }
    if (link.kind === 'Ready' && !this.net.conns.some(c => c.connId === link.connId && c.alive)) {
      v('I32: Ready with a dead stream')
    }
    if (link.kind === 'Opening' && !this.clock.isPending((link as { tOpen?: unknown }).tOpen))
      v('I32: Opening without tOpen')
    // A retryable failure keeps the PUT in retry on its link, if nothing reached the client after it.
    const ra = this.ref.retryAfter
    this.ref.retryAfter = null
    if (
      ra &&
      this.net.lastDelivered === ra.label &&
      link.kind === 'Ready' &&
      link.connId === ra.connId &&
      s.put?.phase !== 'retry'
    ) {
      v(`I34: retryable PUT failure left ${s.put ? `phase ${s.put.phase}` : 'no PUT'}`)
    }
    if (s.session && s.session.generation !== this.ref.generation)
      v(`I29: generation ${s.session.generation} ≠ ${this.ref.generation}`)
    if (s.deferredTimer !== null && !this.clock.isPending(s.deferredTimer))
      v('I38: deferredTimer handle not pending')
    const sentSet = new Set(s.sent)
    const allowed = new Set(refFuse([...this.ref.owners.values()]))
    for (const k of sentSet) if (!allowed.has(k)) v(`I27: ${k} in sent but in no current list`)
  }

  checkRest(): void {
    const s = this.client.inspect()
    const v = (m: string) => this.violations.push(`rest: ${m}`)
    const link = s.link as Record<string, unknown> & { kind: string }
    // MC-M6 (F-28): after a retired terminal on an older generation the latch
    // does not block, and nothing calls ensureOpen until the next event.
    const retiredIdle = this.retiredOldExpiry > 0 && s.latch !== null && link.kind === 'Idle'
    const blocked =
      retiredIdle ||
      !s.session?.token ||
      s.envSwitching ||
      (s.latch !== null && s.latch.generation >= s.session.generation) ||
      (s.unsupportedGeneration !== null && s.unsupportedGeneration >= s.session.generation)
    if (!blocked) {
      if (link.kind === 'Idle') v('I45: Idle with a session')
      if (link.kind === 'Backoff' && !this.clock.isPending(link.timer))
        v('I45: Backoff without timer')
      if (link.kind === 'Opening' && !this.clock.isPending(link.tOpen))
        v('I45: Opening without tOpen')
      if (link.kind === 'Ready' && !this.clock.isPending(link.watchdog))
        v('I45: Ready without watchdog')
    }
    if (this.ref.hop === 0 && (s.session?.token ?? null) !== this.ref.appToken)
      v('I41: session token ≠ app token')
    const expectedSent = this.expectedSent()
    if (JSON.stringify(s.sent) !== JSON.stringify(expectedSent))
      v(`I27: sent ${JSON.stringify(s.sent)} ≠ ${JSON.stringify(expectedSent)}`)
    if (link.kind === 'Ready') {
      const sent = new Set(expectedSent)
      const deferred = link.deferred as Set<string>
      const poison = this.ref.poison
      const poisoned =
        poison !== null &&
        poison.connId === link.connId &&
        poison.keys.size === sent.size &&
        [...sent].every(k => poison.keys.has(k))
      // Every accepted key of `sent` was announced to the renderers since this link's ready.
      const mark = this.readyMark.get(link.g as number) ?? 0
      const resynced = new Set(
        this.events
          .slice(mark)
          .filter(e => e.type === 'resync')
          .flatMap(e => e.keys ?? [])
      )
      for (const k of link.accepted as Set<string>)
        if (sent.has(k) && !resynced.has(k)) v(`liveness: ${k} accepted without resync`)
      if (
        !poisoned &&
        [...deferred].some(k => sent.has(k)) &&
        s.deferredTimer === null &&
        s.put === null
      )
        v('I37: deferred key without retry')
      if (!poisoned) {
        const acked = link.ackedKeys as Set<string>
        const conn = this.net.conns.find(c => c.connId === link.connId)!
        const same = (a: Set<string>, b: Set<string>) =>
          a.size === b.size && [...a].every(x => b.has(x))
        if (!same(acked, sent))
          v(`I21: acked ${JSON.stringify([...acked])} ≠ sent ${JSON.stringify([...sent])}`)
        if (!same(conn.keys, link.accepted as Set<string>)) v('I21: server set ≠ accepted')
      }
    }
    if (this.net.liveGets().length > 1) v('I18: more than one stream')
  }

  /** Healthy network: answer, apply and deliver everything until nothing moves. */
  async drain(): Promise<void> {
    const all: (keys: string[]) => Decision = keys => ({
      accepted: keys,
      rejected: [],
      deferred: [],
    })
    for (let i = 0; i < 400; i++) {
      await flush()
      if (this.s.count() > 0) {
        await this.s.waitAll()
        continue
      }
      const g = this.net.pendingGets()[0]
      if (g) {
        this.net.answerGetReady(g, all(g.keys))
        continue
      }
      const p = this.net.pendingPuts()[0]
      if (p) {
        this.net.answerPut(p, { status: 202 })
        continue
      }
      const withCmd = this.net.liveConns().find(c => c.cmds.length > 0)
      if (withCmd) {
        this.net.applyCommand(withCmd, all)
        continue
      }
      if (this.ref.hop > 0) {
        this.ref.hop = 1
        this.hop(false, false)
        continue
      }
      if (this.ref.env) {
        this.env(false, false)
        continue
      }
      if (this.ref.token === null) {
        this.publish('login', false)
        continue
      }
      const link = this.client.inspect().link as { kind: string; watchdog?: unknown }
      const progress = this.clock
        .pending()
        .find(t => !(link.kind === 'Ready' && t === link.watchdog))
      if (progress) {
        this.clock.fire(progress)
        continue
      }
      return
    }
    this.violations.push('rest: never reached')
  }
}

type Real = { sys: System }
class Cmd implements fc.AsyncCommand<object, Real> {
  constructor(
    private name: string,
    private f: (s: System) => void | Promise<void>,
    /** Deliver everything the command scheduled before the next one; false keeps it in flight. */
    private release = true
  ) {}
  check() {
    return true
  }
  async run(_m: object, r: Real) {
    await this.f(r.sys)
    await flush()
    if (this.release) {
      while (r.sys.s.count() > 0) {
        await r.sys.s.waitAll()
        await flush()
      }
    }
    r.sys.checkSafety(this.name)
  }
  toString() {
    return this.release ? this.name : `${this.name}~`
  }
  held(): Cmd {
    return new Cmd(this.name, this.f, false)
  }
}
const cmd = (name: string, f: (s: System) => void | Promise<void>) => new Cmd(name, f)

const keyList = fc.shuffledSubarray(KEYS)
const mask = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 31 }))
const ra = fc.option(fc.integer({ min: 0, max: 8_000 }), { nil: undefined })
const raHeader = fc.oneof(fc.constant(undefined), fc.constantFrom('0', '2', '30', 'garbage'))
const pick = (keys: string[], m: number) => keys.filter((_, i) => (m >> i) & 1)
const decide =
  (rej: number, def: number, retryAfterMs?: number) =>
  (keys: string[]): Decision => {
    const rejected = pick(keys, rej)
    const deferred = pick(keys, def).filter(k => !rejected.includes(k))
    return {
      accepted: keys.filter(k => !rejected.includes(k) && !deferred.includes(k)),
      rejected,
      deferred,
      ...(deferred.length > 0 && retryAfterMs !== undefined ? { retryAfterMs } : {}),
    }
  }

const getAnswers = fc.oneof(
  { weight: 3, arbitrary: fc.constant('ready') },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      'ready',
      'readyBadHb',
      '400',
      '401',
      '403retired',
      '403other',
      '403null',
      '426',
      '409unsupported',
      '409other',
      '503reauth',
      '503',
      '429',
      '404',
      '502',
      'noBody',
      'network',
      'readyThenEof',
      'eofBeforeReady',
      'heartbeatFirst',
      'headersOnly',
      'headersOnly'
    ),
  }
)
const putAnswers = fc.constantFrom(
  '202',
  '202',
  '202',
  '200text',
  '204',
  '400',
  '401',
  '403retired',
  '403other',
  '426',
  '409unsupported',
  '404',
  '429',
  '503',
  'network'
)
const streamEvents = fc.constantFrom(
  'changed',
  'heartbeat',
  'roots',
  'unknown',
  'garbage',
  'secondReady',
  'eof',
  'error',
  'partialEof',
  'listener_lost',
  'max_lifetime',
  'server_shutdown',
  'reauthorize',
  'session_expired',
  'future_reason',
  'lateReady',
  'lateReady'
)

const baseCommands = [
  fc
    .tuple(
      fc.nat(2),
      keyList,
      fc.constantFrom<'none' | 'user' | 'doc'>('none', 'none', 'none', 'user', 'doc')
    )
    .map(([o, k, st]) =>
      cmd(`setList(${o},${k.map(x => KEYS.indexOf(x))},${st})`, s => s.setList(o, k, st))
    ),
  fc
    .tuple(
      fc.nat(2),
      fc.constantFrom<'navigate' | 'gone' | 'stop' | 'destroy'>(
        'navigate',
        'gone',
        'stop',
        'destroy'
      )
    )
    .map(([o, e]) => cmd(`owner(${o},${e})`, s => s.ownerEvent(o, e))),
  fc
    .tuple(
      fc.constantFrom<'refresh' | 'otherGen' | 'otherUser' | 'logout' | 'opaque' | 'login'>(
        'refresh',
        'refresh',
        'otherGen',
        'otherUser',
        'logout',
        'opaque',
        'login'
      ),
      fc.boolean()
    )
    .map(([k, stop]) => cmd(`E15(${k}${stop ? '+E21' : ''})`, s => s.publish(k, stop))),
  fc
    .tuple(fc.boolean(), fc.boolean())
    .map(([enter, commit]) =>
      cmd(`hop(${enter ? 'enter' : 'release'}${commit ? ',commit' : ''})`, s =>
        s.hop(enter, commit)
      )
    ),
  fc
    .tuple(fc.boolean(), fc.boolean())
    .map(([start, changed]) =>
      cmd(`env(${start ? 'start' : 'end'}${changed ? ',changed' : ''})`, s => s.env(start, changed))
    ),
  fc.tuple(getAnswers, mask, mask, ra, raHeader).map(([a, rej, def, r, h]) =>
    cmd(`answerGet(${a},${rej},${def},${r},${h})`, s => {
      const g = s.net.pendingGets()[0]
      if (!g) return
      const err = (status: number, code?: string) =>
        s.net.answerGet(g, { status, code, retryAfter: h })
      switch (a) {
        case 'ready':
          return s.net.answerGetReady(g, decide(rej, def, r)(g.keys))
        case 'readyBadHb':
          return s.net.answerGetReady(g, decide(0, 0)(g.keys), 1_000)
        case 'readyThenEof':
          s.net.answerGetReady(g, decide(rej, def, r)(g.keys))
          return s.net.write(g.conn!, 'EOF')
        case 'eofBeforeReady':
          s.net.answerGetReady(g, decide(0, 0)(g.keys), 20_000, { skipReady: true })
          return s.net.write(g.conn!, 'EOF')
        case 'headersOnly':
          // 2xx with the stream open and no ready yet: `stream(lateReady)` writes it.
          return s.net.answerGetReady(g, decide(rej, def, r)(g.keys), 20_000, { skipReady: true })
        case 'heartbeatFirst':
          s.net.answerGetReady(g, decide(0, 0)(g.keys), 20_000, { skipReady: true })
          return s.net.frame(g.conn!, { type: 'heartbeat' })
        case '400':
          return err(400, 'bad_request')
        case '401':
          return err(401, 'session_invalid')
        case '403retired':
          return err(403, 'desktop_user_retired')
        case '403other':
          return err(403, 'gfs_operator_link_invalid')
        case '403null':
          return err(403)
        case '426':
          return err(426, 'upgrade_required')
        case '409unsupported':
          return err(409, 'session_contract_unsupported')
        case '409other':
          return err(409, 'conflict')
        case '503reauth':
          return err(503, 'watch_reauthorize')
        case '503':
          return err(503, 'watch_reopen')
        case '429':
          return err(429, 'rate_limited')
        case '404':
          return err(404)
        case '502':
          return err(502)
        case 'noBody':
          return s.net.answerGet(g, 'noBody')
        default:
          return s.net.answerGet(g, 'network')
      }
    })
  ),
  fc.tuple(fc.nat(1), putAnswers, raHeader).map(([w, a, h]) =>
    cmd(`answerPut(${w},${a},${h})`, s => {
      const p = s.net.pendingPuts()[w] ?? s.net.pendingPuts()[0]
      if (!p) return
      const codes: Record<string, [number, string?, string?]> = {
        '202': [202],
        '200text': [200, undefined, 'ok'],
        '204': [204],
        '400': [400, 'bad_request'],
        '401': [401, 'session_invalid'],
        '403retired': [403, 'desktop_user_retired'],
        '403other': [403, 'forbidden'],
        '426': [426, 'upgrade_required'],
        '409unsupported': [409, 'session_contract_unsupported'],
        '404': [404],
        '429': [429, 'rate_limited'],
        '503': [503, 'watch_reopen'],
      }
      if (a === 'network') return s.net.answerPut(p, 'network')
      const [status, code, body] = codes[a]!
      s.net.answerPut(p, { status, code, retryAfter: h, body })
    })
  ),
  fc.tuple(mask, mask, ra).map(([rej, def, r]) =>
    cmd(`applyCmd(${rej},${def},${r})`, s => {
      const c = s.net.liveConns().find(x => x.cmds.length > 0)
      if (c) s.net.applyCommand(c, decide(rej, def, r))
    })
  ),
  streamEvents.map(e =>
    cmd(`stream(${e})`, s => {
      const c = s.currentConn()
      if (!c) return
      switch (e) {
        case 'lateReady': {
          const pending = s.net.liveConns().find(x => !x.readySent)
          return (
            pending &&
            s.net.writeReady(pending, decide(0, 0)(s.net.gets.find(g => g.conn === pending)!.keys))
          )
        }
        case 'changed':
          return s.net.frame(c, { type: 'changed', keys: [...c.keys] })
        case 'heartbeat':
          return s.net.frame(c, { type: 'heartbeat' })
        case 'roots':
          return s.net.frame(c, { type: 'roots_changed' })
        case 'unknown':
          return s.net.frame(c, { type: 'from_the_future' })
        case 'garbage':
          return s.net.write(c, '{"schemaVersion":1,\n')
        case 'secondReady':
          if (!c.readySent) return
          return s.net.frame(c, {
            type: 'ready',
            connId: c.connId,
            heartbeatMs: 20_000,
            accepted: [],
            rejected: [],
            deferred: [],
          })
        case 'eof':
          return s.net.write(c, 'EOF')
        case 'error':
          return s.net.write(c, 'ERROR')
        case 'partialEof':
          s.net.write(c, '{"schemaVersion":1,"type":"heartbeat"}')
          return s.net.write(c, 'EOF')
        default:
          return s.net.frame(c, { type: 'stream.closing', reason: e, retryAfterMs: 1_000 })
      }
    })
  ),
  fc
    .constantFrom('progress', 'progress', 'progress', 'any')
    .map(k => cmd(`fire(${k})`, s => s.fireNext(k))),
  // The race behind every newer-session gate: the app refreshes the token
  // (same binding) while an answer or frame for the old one is on its way.
  fc.constantFrom('closingExpired', 'get401', 'put401', 'get426', 'put409').map(k =>
    cmd(`race(refresh,${k})`, s => {
      const g = s.net.pendingGets()[0]
      const p = s.net.pendingPuts()[0]
      const c = s.currentConn()
      s.publish('refresh', false)
      if (k === 'closingExpired' && c)
        s.net.frame(c, { type: 'stream.closing', reason: 'session_expired' })
      if (k === 'get401' && g) s.net.answerGet(g, { status: 401, code: 'session_invalid' })
      if (k === 'get426' && g) s.net.answerGet(g, { status: 426, code: 'upgrade_required' })
      if (k === 'put401' && p) s.net.answerPut(p, { status: 401, code: 'session_invalid' })
      if (k === 'put409' && p)
        s.net.answerPut(p, { status: 409, code: 'session_contract_unsupported' })
    })
  ),
  fc.constant(
    cmd('deliver', async s => {
      if (s.s.count() > 0) await s.s.waitOne()
    })
  ),
]

const coverage = {
  runs: 0,
  cmds: 0,
  gets: 0,
  puts: 0,
  ready: 0,
  restReady: 0,
  expiries: 0,
  putRuns: 0,
  acceptedRetiredOldExpiry: 0,
}
afterAll(() => {
  if (process.env.GFS_WATCH_MODEL_COVERAGE) console.log(JSON.stringify(coverage))
})
// Weights, in the order of `baseCommands`: list changes, PUT answers and
// command application are the most frequent, so that most runs contain PUT
// episodes; one command in four leaves its deliveries in flight.
const W = [10, 2, 2, 1, 1, 6, 8, 7, 3, 4, 2, 2]
const commands = baseCommands.flatMap((c, i) =>
  Array.from({ length: W[i]! }, () =>
    fc
      .tuple(
        c,
        fc.oneof(
          { weight: 3, arbitrary: fc.constant(true) },
          { weight: 1, arbitrary: fc.constant(false) }
        )
      )
      .map(([x, rel]) => (rel ? x : x.held()))
  )
)

let onUnhandled: (r: unknown) => void
const unhandled: unknown[] = []
beforeAll(() => {
  onUnhandled = r => unhandled.push(r)
  process.on('unhandledRejection', onUnhandled)
})
afterAll(() => {
  process.off('unhandledRejection', onUnhandled)
})

describe('GFS watch client: model-based oracle', () => {
  it('keeps every safety invariant on every interleaving and converges at rest', async () => {
    // requestJson reaches the network through the global fetch.
    const realFetch = globalThis.fetch
    let current: System | null = null
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      current!.net.fetch(input, init)
    )
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          fc.integer({ min: 1, max: 2 ** 31 - 1 }),
          fc.commands(commands, { maxCommands: 120, size: 'max' }),
          async (s, seed, cmds) => {
            const sys = new System(s, seed)
            current = sys
            // Every window mounts before the session exists, as at startup.
            for (let i = 0; i < 3; i++) sys.setList(i, [], 'none')
            sys.publish('login', false)
            await flush()
            await fc.asyncModelRun(() => ({ model: {}, real: { sys } }), cmds)
            await sys.drain()
            sys.checkRest()
            coverage.runs += 1
            coverage.gets += sys.net.gets.length
            coverage.puts += sys.net.puts.length
            if (sys.net.puts.length > 0) coverage.putRuns += 1
            coverage.expiries += sys.expiries
            coverage.acceptedRetiredOldExpiry += sys.retiredOldExpiry
            coverage.ready += sys.net.conns.length
            coverage.cmds += [...cmds].length
            if (sys.client.inspect().link.kind === 'Ready') coverage.restReady += 1
            sys.client.dispose()
            await flush()
            expect(unhandled).toEqual([])
            expect(sys.violations).toEqual([])
          }
        ),
        { numRuns: RUNS, seed: SEED }
      )
      // The exploration must reach what it claims to check.
      if (RUNS >= 300) {
        expect(coverage.putRuns / coverage.runs).toBeGreaterThan(0.5)
        expect(coverage.expiries).toBeGreaterThan(20)
        expect(coverage.restReady / coverage.runs).toBeGreaterThan(0.5)
      }
    } finally {
      vi.stubGlobal('fetch', realFetch)
      vi.unstubAllGlobals()
    }
  }, 600_000)
})
