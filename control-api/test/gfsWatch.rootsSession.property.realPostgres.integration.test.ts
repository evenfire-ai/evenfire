import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Pool } from 'pg'
import type { GfsKey, Uuid } from '../src/services/gfsWatch/keys.js'
import type { WatchOpenOutcome } from '../src/services/gfsWatch/registry.js'
import { registryTestDatabase } from './helpers/gfsWatchRegistryEnv.js'
import type {
  BuiltRegistry,
  FakeSocket,
  RegistryHarness,
  TestUser,
} from './helpers/gfsWatchRegistryHarness.js'
import { type Loaded, loadHelpers } from './helpers/gfsWatchRegistryLoad.js'
import './realPostgres.requirement.ts'

// Loaded after the env helper has pointed the core pool at this suite's
// database; see gfsWatchRegistryLoad.ts.
let flushMicrotasks!: Loaded['flushMicrotasks'],
  createRegistryHarness!: Loaded['createRegistryHarness'],
  nextEv!: Loaded['nextEv'],
  quoteIdent!: Loaded['quoteIdent'],
  restInvariantViolations!: Loaded['restInvariantViolations'],
  sleep!: Loaded['sleep']

// Model-based test of the session hint and the roots window (sibling of T-M3)
// on the real registry: real Postgres with the real users, gfs_authz_changed
// and gfs_resource_changed triggers fed by real writes (revoke-all, password
// change and retirement through their services, renames and inserts of the
// tree), the confirmation and the grantee query on the real watch pool, real
// sessions. fc.scheduler decides when each confirmation and grantee query is
// let through; fc.commands interleaves opens, departures, true and forged
// session hints, unreadable ones, roots changes, failed confirmations,
// listener losses (E11) and clock advances with them.
//
// Reference model, deliberately trivial: which user each lifecycle write
// moved, which users a rename reaches (the grants are fixed for the suite),
// and the instant of every frame.
//
// Checked at rest: I14 (a session_expired only after a real lifecycle write
// of that user; every stream admitted before such a write is closed; no
// changed or roots_changed written while the user is held), I35 (no hold, no
// pending reason, no confirmation in flight), I38 (every pending timer has
// its handle), the roots ceiling (two roots_changed of one stream are at
// least 2 s apart) and roots reach (a roots_changed only after a change the
// stream's principal lists). I36 and the handle half of I38 after every
// command.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

type ConnModel = {
  user: number
  socket: FakeSocket
  outcome: WatchOpenOutcome | null
  evs: number[]
  times: number[]
}

type Real = {
  b: BuiltRegistry
  s: fc.Scheduler
  conns: ConnModel[]
  /** user → instants just before each real lifecycle write of it. */
  writes: { user: number; ev: number }[]
  /** Instants at which a confirmation failed or an unreadable hint arrived. */
  failEvs: number[]
  /**
   * Instants just before each roots change and once its write was dispatched,
   * with the users whose roots it changes.
   */
  rootsEvents: { ev: number; evAfter: number; users: Set<number> }[]
  retired: Set<number>
  /**
   * The registry observed at many instants: which users were retained (held,
   * or pending a reauthorization, either of which makes `send` drop a roots
   * notice) and whether no roots notice could still be on its way.
   */
  samples: { ev: number; held: Set<number>; rootsIdle: boolean }[]
  failures: string[]
}

const VICTIM = 3
/** The fixed `examples` of the property. */
const EXAMPLES = 5

describeRealPostgres('GFS watch session hint and roots window model', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let users: TestUser[]
  let dirs: string[]
  let file: string
  let linkingFlag: boolean
  let unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)

  beforeAll(async () => {
    ;({
      flushMicrotasks,
      createRegistryHarness,
      nextEv,
      quoteIdent,
      restInvariantViolations,
      sleep,
    } = await loadHelpers())
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(registryTestDatabase)}`)
    h = await createRegistryHarness(adminUrl!)
    linkingFlag = h.modules.config.config.desktopGfsOperatorLinkingEnabled
    h.modules.config.config.desktopGfsOperatorLinkingEnabled = true
    users = [await h.createUser(), await h.createUser(), await h.createUser()]
    // User 2 is a linked operator; D0 is a root of user 0, D1 of the team (users 0 and 1).
    await h.authz.link(users[2]!.userId, await h.authz.createAdmin())
    const team = await h.authz.createTeam()
    await h.authz.join(team, users[0]!.userId)
    await h.authz.join(team, users[1]!.userId)
    dirs = [await h.tree.add('directory'), await h.tree.add('directory')]
    await h.authz.grant(dirs[0]!, 'user', users[0]!.userId)
    await h.authz.share(dirs[1]!, 'team', team)
    file = await h.tree.add('file', dirs[0])
    process.on('unhandledRejection', onUnhandled)
    process.on('uncaughtException', onUnhandled)
  }, 120_000)

  afterAll(async () => {
    try {
      process.off('unhandledRejection', onUnhandled)
      process.off('uncaughtException', onUnhandled)
      if (h) h.modules.config.config.desktopGfsOperatorLinkingEnabled = linkingFlag
      await h?.teardown()
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [registryTestDatabase]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(registryTestDatabase)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  const key = () => h.key('file', file) as GfsKey
  /** Users whose root listing a rename of D<i> changes. */
  const rootUsersOf = (dir: number) => new Set(dir === 0 ? [0] : [0, 1])
  const isOperator = (user: number) => user === 2

  // ─── Invariant predicates ────────────────────────────────────────────────

  function i36(b: BuiltRegistry): string[] {
    const st = b.registry.state
    const w = st.windows()
    const v: string[] = []
    const uids = new Set<Uuid>([
      ...st.holdUsers.keys(),
      ...w.sessionPending,
      ...w.failClosedPending,
      ...w.sessionConfirming.flatMap(u => [...u]),
    ])
    for (const uid of uids) {
      const expected =
        (w.sessionPending.has(uid) ? 1 : 0) +
        w.sessionConfirming.filter(u => u.has(uid)).length +
        (w.failClosedPending.has(uid) ? 1 : 0)
      const n = st.holdUsers.get(uid) ?? 0
      if (n !== expected) v.push(`I36: ${uid} held ${n}, reasons ${expected}`)
    }
    return v
  }

  const WINDOW_HANDLES = [
    'authzWindow',
    'expansionRetry',
    'failClosedTimer',
    'rootsWindow',
    'sessionWindow',
  ] as const

  function i38Handles(b: BuiltRegistry): string[] {
    const w = b.registry.state.windows()
    const v: string[] = []
    for (const name of WINDOW_HANDLES) {
      if ((w[name] !== null) !== b.clock.isPending(w[name])) v.push(`I38: ${name} handle/pending`)
    }
    for (const conn of b.registry.state.byConnId.values()) {
      const t = conn.timers.rootsTrailing
      if ((t !== null) !== b.clock.isPending(t)) v.push(`I38: ${conn.connId} rootsTrailing`)
    }
    return v
  }

  function i38Count(b: BuiltRegistry): string[] {
    const st = b.registry.state
    const w = st.windows()
    const l = st.listener
    let expected = 0
    for (const t of [l.pingInterval, l.echoInterval, l.tConnect, l.reconnectTimer]) {
      if (t !== null) expected += 1
    }
    for (const name of WINDOW_HANDLES) if (w[name] !== null) expected += 1
    for (const conn of st.byConnId.values()) {
      for (const t of Object.values(conn.timers)) if (t !== null) expected += 1
      if (conn.op) expected += (conn.op.tAuth ? 1 : 0) + (conn.op.tSrv ? 1 : 0)
    }
    const pending = b.clock.pendingCount()
    return pending === expected ? [] : [`I38: ${pending} timers pending, ${expected} handles`]
  }

  function i35(b: BuiltRegistry): string[] {
    const st = b.registry.state
    const w = st.windows()
    const v: string[] = []
    if (st.holdUsers.size > 0) v.push(`I35: holdUsers ${[...st.holdUsers.keys()]}`)
    if (w.sessionPending.size > 0) v.push('I35: sessionPending')
    if (w.failClosedPending.size > 0) v.push('I35: failClosedPending')
    if (w.sessionConfirming.length > 0) v.push('I35: confirmation in flight')
    return v
  }

  function quiet(b: BuiltRegistry): boolean {
    const w = b.registry.state.windows()
    const g = b.gates
    return (
      WINDOW_HANDLES.every(n => w[n] === null) &&
      w.sessionConfirming.length === 0 &&
      w.reauthUsers.size === 0 &&
      w.reauthConns.size === 0 &&
      [...b.registry.state.byConnId.values()].every(c => c.timers.rootsTrailing === null) &&
      [g.expansion, g.roots, g.session].every(x => x.calls === x.done)
    )
  }

  // ─── Retention intervals ─────────────────────────────────────────────────

  function sample(real: Real): void {
    const st = real.b.registry.state
    const w = st.windows()
    const held = new Set<number>()
    users.forEach((u, i) => {
      if ((st.holdUsers.get(u.userId) ?? 0) > 0 || w.reauthUsers.has(u.userId)) held.add(i)
    })
    for (const m of real.conns) {
      const conn = real.b.connOf(m.socket)
      if (conn && w.reauthConns.has(conn)) held.add(m.user)
    }
    const g = real.b.gates.roots
    const rootsIdle =
      w.rootsWindow === null &&
      g.calls === g.done &&
      [...st.byConnId.values()].every(c => c.timers.rootsTrailing === null)
    real.samples.push({ ev: nextEv(), held, rootsIdle })
  }

  /**
   * Intervals in which the user may have been retained. A hold starts and
   * ends between samples, so each run of held samples is widened to the
   * unheld samples around it: the interval can only be too long, never miss
   * a retention.
   */
  function heldIntervals(real: Real, user: number): [number, number][] {
    const out: [number, number][] = []
    let start: number | null = null
    let lastUnheld = 0
    for (const x of real.samples) {
      if (x.held.has(user)) {
        if (start === null) start = lastUnheld
      } else {
        if (start !== null) out.push([start, x.ev])
        start = null
        lastUnheld = x.ev
      }
    }
    if (start !== null) out.push([start, Number.POSITIVE_INFINITY])
    return out
  }

  /** From just before the change until no window, grantee query or trailing notice is left. */
  function flushSpan(real: Real, e: Real['rootsEvents'][number]): [number, number] {
    const end = real.samples.find(x => x.ev > e.evAfter && x.rootsIdle)?.ev
    return [e.ev, end ?? Number.POSITIVE_INFINITY]
  }

  // ─── Commands ────────────────────────────────────────────────────────────

  function track(real: Real, m: ConnModel): void {
    m.socket.onFrame = (f, ev) => {
      sample(real)
      m.evs.push(ev)
      m.times.push(real.b.clock.now())
      // I14: nothing a retention suppresses is written while the user is held.
      if (f.type === 'changed' || f.type === 'roots_changed') {
        const uid = users[m.user]!.userId
        if ((real.b.registry.state.holdUsers.get(uid) ?? 0) > 0) {
          real.failures.push(`I14: ${String(f.type)} written to held u${m.user}`)
        }
      }
    }
  }

  class OpenCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly user: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      if (real.retired.has(this.user)) return
      const o = real.b.open(users[this.user]!, isOperator(this.user) ? [] : [key()])
      const m: ConnModel = {
        user: this.user,
        socket: o.socket,
        outcome: null,
        evs: [],
        times: [],
      }
      track(real, m)
      real.conns.push(m)
      void o.outcome.then(out => {
        m.outcome = out
      })
      await sleep(2)
    }
    toString = () => `Open(u${this.user})`
  }

  class GoneCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly conn: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      if (real.conns.length) real.conns[this.conn % real.conns.length]!.socket.emitGone()
    }
    toString = () => `Gone(${this.conn})`
  }

  class SettleOpensCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      for (let i = 0; i < 200 && real.conns.some(c => c.outcome === null); i += 1) {
        if (real.s.count() > 0) await real.s.waitOne()
        await sleep(3)
      }
    }
    toString = () => 'SettleOpens'
  }

  /** A real lifecycle write: the users trigger emits the hint. */
  class LifecycleCmd implements fc.AsyncCommand<object, Real> {
    constructor(
      readonly user: number,
      readonly writer: 'revoke-all' | 'password' | 'retire'
    ) {}
    check = () => true
    async run(_m: object, real: Real) {
      const u = this.writer === 'retire' ? VICTIM : this.user
      if (real.retired.has(u)) return
      real.writes.push({ user: u, ev: nextEv() })
      const uid = users[u]!.userId
      if (this.writer === 'retire') {
        await h.lifecycle.retire(uid)
        real.retired.add(u)
      } else if (this.writer === 'password') await h.lifecycle.changePassword(uid)
      else await h.lifecycle.revokeAll(uid)
      await h.barrier()
      if (this.writer !== 'retire') users[u] = await h.reissue(users[u]!)
    }
    toString = () => (this.writer === 'retire' ? 'Retire(victim)' : `${this.writer}(u${this.user})`)
  }

  class ForgedHintCmd implements fc.AsyncCommand<object, Real> {
    constructor(
      readonly user: number,
      readonly state: 'active' | 'retired' | 'deleted',
      readonly delta: number
    ) {}
    check = () => true
    async run(_m: object, real: Real) {
      const u = users[this.user]!
      const g = (await h.lifecycle.version(u.userId))?.version ?? 1
      const v = Math.max(1, g + this.delta)
      await h.writer.query(`SELECT pg_notify('gfs_watch_session', $1)`, [
        `${u.userId}:${this.state}:${v}`,
      ])
      await h.barrier()
    }
    toString = () =>
      `Forged(u${this.user}:${this.state}:g${this.delta >= 0 ? '+' : ''}${this.delta})`
  }

  class InvalidHintCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      real.failEvs.push(nextEv())
      await h.writer.query(`SELECT pg_notify('gfs_watch_session', 'garbage')`)
      await h.barrier()
    }
    toString = () => 'InvalidHint'
  }

  class RenameCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly dir: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const ev = nextEv()
      await h.tree.rename(dirs[this.dir]!)
      await h.barrier()
      real.rootsEvents.push({ ev, evAfter: nextEv(), users: rootUsersOf(this.dir) })
    }
    toString = () => `Rename(D${this.dir})`
  }

  /** op = i: only the linked operator's listing changes. */
  class InsertCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      const ev = nextEv()
      await h.tree.add('file', dirs[0])
      await h.barrier()
      real.rootsEvents.push({ ev, evAfter: nextEv(), users: new Set() })
    }
    toString = () => 'Insert'
  }

  class SessionFailCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly n: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const gate = real.b.gates.session
      let left = this.n
      gate.failWith = () => {
        left -= 1
        if (left <= 0) gate.mode = 'pass'
        real.failEvs.push(nextEv())
        return new Error('Connection terminated unexpectedly')
      }
      gate.mode = 'fail'
    }
    toString = () => `SessionFail(${this.n})`
  }

  class ListenerLossCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      const terminated = await h.terminateListener()
      for (let i = 0; i < 400 && real.b.registry.listenerReady(); i += 1) await sleep(5)
      if (terminated !== 1 || real.b.registry.listenerReady()) {
        real.failures.push(`harness: listener loss not induced (${terminated} backends ended)`)
        return
      }
      real.b.clock.advance(1_200)
      for (let i = 0; i < 1_000 && !real.b.registry.listenerReady(); i += 1) await sleep(5)
    }
    toString = () => 'ListenerLoss'
  }

  class AdvanceCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly ms: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      await real.b.advance(this.ms)
    }
    toString = () => `Advance(${this.ms})`
  }

  class StepCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly n: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      for (let i = 0; i < this.n; i += 1) {
        if (real.s.count() > 0) await real.s.waitOne()
        await sleep(3)
      }
    }
    toString = () => `Step(${this.n})`
  }

  // ─── Rest ────────────────────────────────────────────────────────────────

  /** No scheduled step, op, open, expansion, grantee query or confirmation in flight. */
  async function settle(real: Real, rounds = 300): Promise<void> {
    const g = real.b.gates
    const idle = () =>
      real.s.count() === 0 &&
      real.b.registry.state.opsInFlight.size === 0 &&
      !real.conns.some(c => c.outcome === null) &&
      [g.expansion, g.roots, g.session].every(x => x.calls === x.done) &&
      real.b.registry.state.windows().sessionConfirming.length === 0
    for (let i = 0; i < rounds; i += 1) {
      if (real.s.count() > 0) await real.s.waitAll()
      await sleep(3)
      await flushMicrotasks()
      sample(real)
      if (idle()) {
        await sleep(5)
        await flushMicrotasks()
        if (idle()) return
      }
    }
    throw new Error('model run did not reach rest')
  }

  async function rest(real: Real): Promise<void> {
    real.b.gates.session.mode = 'pass'
    await settle(real)
    for (const ms of [300, 600, 2_100, 300, 5_100, 300]) {
      await real.b.advance(ms)
      await settle(real)
    }
    for (let i = 0; i < 20 && !quiet(real.b); i += 1) {
      await real.b.advance(600)
      await settle(real)
    }
    if (!quiet(real.b)) throw new Error('registry windows did not drain')
  }

  // ─── Reference model ─────────────────────────────────────────────────────

  function checkModel(real: Real, checked: { n: number }): string[] {
    const v: string[] = []
    for (const m of real.conns) {
      const conn = real.b.connOf(m.socket)
      const admitted = m.socket.admittedEv
      if (m.outcome === null) v.push('open did not resolve')
      const writesOfUser = real.writes.filter(w => w.user === m.user)
      // I14 liveness: a stream admitted before a lifecycle write of its user is closed.
      for (const w of writesOfUser) {
        if (admitted !== null && admitted < w.ev && conn && conn.phase !== 'closed') {
          v.push(`I14: u${m.user} admitted at ${admitted} open after its write at ${w.ev}`)
        }
      }
      let lastRoots = Number.NEGATIVE_INFINITY
      m.socket.frames.forEach((f, i) => {
        const ev = m.evs[i] ?? 0
        if (f.type === 'stream.closing' && f.reason === 'session_expired') {
          // I14 safety: no hint, forged or not, ends a session the row keeps.
          if (!writesOfUser.some(w => w.ev < ev)) {
            v.push(`I14: session_expired to u${m.user} at ${ev} with no lifecycle write`)
          }
        }
        if (f.type === 'stream.closing' && f.reason === 'reauthorize') {
          const explained = real.failEvs.some(e => e < ev) || writesOfUser.some(w => w.ev < ev)
          if (!explained) v.push(`reauthorize to u${m.user} at ${ev} with no cause`)
        }
        if (f.type === 'roots_changed') {
          const t = m.times[i]!
          if (t - lastRoots < 2_000) v.push(`roots ceiling: u${m.user} ${t - lastRoots} ms apart`)
          lastRoots = t
          const reached = real.rootsEvents.some(
            e => e.ev < ev && (isOperator(m.user) || e.users.has(m.user))
          )
          if (!reached) v.push(`roots reach: u${m.user} at ${ev} with no change it lists`)
        }
      })
      // Roots liveness: a change the stream lists, after its ready, is announced
      // by rest, unless the user may have been retained while that change was
      // being flushed (a retained notice is dropped by design: the client
      // refetches its roots on every ready).
      const readyAt = m.socket.frames.findIndex(f => f.type === 'ready')
      const open = conn !== undefined && conn.phase !== 'closed'
      if (readyAt >= 0 && open) {
        const readyEv = m.evs[readyAt]!
        const held = heldIntervals(real, m.user)
        for (const e of real.rootsEvents) {
          if (e.ev <= readyEv || !(isOperator(m.user) || e.users.has(m.user))) continue
          const [from, to] = flushSpan(real, e)
          if (held.some(([a, z]) => a < to && z > from)) continue
          checked.n += 1
          const announced = m.socket.frames.some(
            (f, i) => f.type === 'roots_changed' && m.evs[i]! > e.ev
          )
          if (!announced) v.push(`roots liveness: u${m.user} never told of the change at ${e.ev}`)
        }
      }
    }
    return v
  }

  /** Liveness checks per run; the fixed examples must each make at least one. */
  const livenessPerRun: number[] = []

  const coverage = {
    sessionExpired: 0,
    reauthorizeOnFail: 0,
    confirmations: 0,
    falseHintsResolved: 0,
    rootsFrames: 0,
    operatorRoots: 0,
    listenerLost: 0,
  }

  const userIdx = fc.nat(2)
  const commands = [
    fc.nat(VICTIM).map(u => new OpenCmd(u)),
    userIdx.map(u => new OpenCmd(u)),
    fc.constant(new SettleOpensCmd()),
    fc.constant(new SettleOpensCmd()),
    fc.nat(5).map(c => new GoneCmd(c)),
    fc
      .tuple(userIdx, fc.constantFrom('revoke-all', 'revoke-all', 'password', 'retire'))
      .map(([u, w]) => new LifecycleCmd(u, w as 'revoke-all' | 'password' | 'retire')),
    fc
      .tuple(
        fc.nat(VICTIM),
        fc.constantFrom('active', 'retired', 'deleted'),
        fc.integer({ min: -1, max: 1 })
      )
      .map(([u, st, d]) => new ForgedHintCmd(u, st as 'active' | 'retired' | 'deleted', d)),
    fc.constant(new InvalidHintCmd()),
    fc.nat(1).map(d => new RenameCmd(d)),
    fc.constant(new InsertCmd()),
    fc.integer({ min: 1, max: 2 }).map(n => new SessionFailCmd(n)),
    fc.constant(new ListenerLossCmd()),
    fc.constantFrom(250, 600, 2_000, 5_000).map(ms => new AdvanceCmd(ms)),
    fc.integer({ min: 1, max: 4 }).map(n => new StepCmd(n)),
  ]

  const ex = (seed: number, cmds: unknown[]) => [
    fc.sample(fc.scheduler(), { seed, numRuns: 1 })[0]!,
    cmds as Iterable<fc.AsyncCommand<object, Real>>,
  ]

  it('keeps I14, I35, I36, I38 and the roots ceiling under scheduled confirmations and grantee queries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(commands, { maxCommands: 20, size: 'large' }),
        async (s, cmds) => {
          // The victim is fresh in every run: its retirement is permanent.
          users[VICTIM] = await h.createUser()
          const b = await h.build()
          const real: Real = {
            b,
            s,
            conns: [],
            writes: [],
            failEvs: [],
            rootsEvents: [],
            retired: new Set(),
            samples: [],
            failures: [],
          }
          const hook = (label: string) => {
            sample(real)
            return s.schedule(Promise.resolve(label)).then(() => {
              sample(real)
            })
          }
          b.gates.session.hook = hook
          b.gates.roots.hook = hook
          const confirm0 = b.gates.session.done
          try {
            const wrapped = [...cmds].map(c => ({
              check: () => true,
              run: async (m: object, r: Real) => {
                await c.run(m, r)
                await flushMicrotasks()
                sample(r)
                r.failures.push(...i36(r.b).map(x => `${x} after ${c.toString()}`))
                r.failures.push(...i38Handles(r.b).map(x => `${x} after ${c.toString()}`))
                r.failures.push(...i38Count(r.b).map(x => `${x} after ${c.toString()}`))
              },
              toString: () => c.toString(),
            }))
            await fc.asyncModelRun(() => ({ model: {}, real }), wrapped)
            await rest(real)
            sample(real)
            const checked = { n: 0 }
            const closed = real.conns.flatMap(c => {
              const conn = b.connOf(c.socket)
              return conn && conn.phase === 'closed' ? [conn] : []
            })
            const violations = [
              ...real.failures,
              ...b.violations(),
              ...restInvariantViolations(b, closed),
              ...checkModel(real, checked),
              ...i35(b),
              ...i36(b),
              ...i38Handles(b),
              ...i38Count(b),
              ...unhandled.map(e => `unhandled: ${String(e)}`),
            ]
            unhandled = []
            livenessPerRun.push(checked.n)
            for (const m of real.conns) {
              const reasons = m.socket.framesOf('stream.closing').map(f => f.reason)
              coverage.sessionExpired += reasons.filter(r => r === 'session_expired').length
              coverage.listenerLost += reasons.filter(r => r === 'listener_lost').length
              if (reasons.includes('reauthorize') && real.failEvs.length > 0) {
                coverage.reauthorizeOnFail += 1
              }
              const n = m.socket.framesOf('roots_changed').length
              coverage.rootsFrames += n
              if (isOperator(m.user)) coverage.operatorRoots += n
            }
            const confirmations = b.gates.session.done - confirm0
            coverage.confirmations += confirmations
            if (confirmations > 0 && real.writes.length === 0 && real.failEvs.length === 0) {
              coverage.falseHintsResolved += 1
            }
            expect(violations).toEqual([])
          } finally {
            b.gates.session.hook = null
            b.gates.roots.hook = null
            await b.stop()
          }
        }
      ),
      {
        numRuns: Number(process.env.GFS_WATCH_MODEL_RUNS ?? 30) + 5,
        endOnFailure: true,
        verbose: 1,
        // Fixed sequences that reach every path whatever the random runs draw:
        // a false hint overlapping a true write with the confirmation held;
        // a failed confirmation and an unreadable hint; roots changes inside
        // the ceiling with the user held across the trailing; a listener loss
        // with a confirmation and a grantee query in flight; a retirement.
        examples: [
          ex(7, [
            new OpenCmd(0),
            new OpenCmd(1),
            new OpenCmd(2),
            new SettleOpensCmd(),
            new ForgedHintCmd(0, 'retired', 0),
            new AdvanceCmd(250),
            new LifecycleCmd(0, 'revoke-all'),
            new StepCmd(1),
            new AdvanceCmd(250),
            new StepCmd(2),
            new OpenCmd(0),
            new SettleOpensCmd(),
            new ForgedHintCmd(1, 'active', 1),
            new AdvanceCmd(600),
            new RenameCmd(1),
            new AdvanceCmd(250),
            new StepCmd(2),
          ]),
          ex(11, [
            new OpenCmd(0),
            new OpenCmd(1),
            new OpenCmd(2),
            new SettleOpensCmd(),
            new SessionFailCmd(1),
            new ForgedHintCmd(1, 'deleted', 0),
            new AdvanceCmd(250),
            new StepCmd(1),
            new InvalidHintCmd(),
            new AdvanceCmd(600),
            new OpenCmd(1),
            new SettleOpensCmd(),
            new LifecycleCmd(1, 'password'),
            new AdvanceCmd(250),
            new StepCmd(2),
            new AdvanceCmd(5_000),
            new StepCmd(2),
            // The fail-closed reopened everyone: a fresh stream to tell.
            new OpenCmd(2),
            new SettleOpensCmd(),
            new RenameCmd(0),
            new AdvanceCmd(250),
            new StepCmd(2),
          ]),
          ex(13, [
            new OpenCmd(0),
            new OpenCmd(2),
            new SettleOpensCmd(),
            new RenameCmd(0),
            new AdvanceCmd(250),
            new StepCmd(2),
            new ForgedHintCmd(0, 'retired', 0),
            new RenameCmd(1),
            new InsertCmd(),
            new AdvanceCmd(250),
            new StepCmd(1),
            new AdvanceCmd(2_000),
            new StepCmd(2),
            new RenameCmd(0),
            new AdvanceCmd(250),
          ]),
          // Hints and roots changes accumulating in one window each.
          ex(19, [
            new OpenCmd(0),
            new OpenCmd(1),
            new OpenCmd(2),
            new SettleOpensCmd(),
            new RenameCmd(1),
            new RenameCmd(0),
            new InsertCmd(),
            new AdvanceCmd(250),
            new StepCmd(2),
            new AdvanceCmd(2_000),
            new StepCmd(2),
            new ForgedHintCmd(1, 'retired', 0),
            new ForgedHintCmd(1, 'deleted', 0),
            new ForgedHintCmd(0, 'active', 1),
            new AdvanceCmd(250),
            new StepCmd(2),
          ]),
          ex(17, [
            new OpenCmd(0),
            new OpenCmd(1),
            new OpenCmd(VICTIM),
            new SettleOpensCmd(),
            new ForgedHintCmd(0, 'retired', 0),
            new RenameCmd(1),
            new AdvanceCmd(250),
            new ListenerLossCmd(),
            new OpenCmd(1),
            new SettleOpensCmd(),
            new StepCmd(3),
            new LifecycleCmd(0, 'retire'),
            new AdvanceCmd(600),
            new StepCmd(3),
            new RenameCmd(1),
            new AdvanceCmd(250),
            new StepCmd(2),
          ]),
        ],
      }
    )
    expect(Object.entries(coverage).filter(([, n]) => n === 0)).toEqual([])
    // fast-check runs the examples first, in order.
    expect(livenessPerRun.slice(0, EXAMPLES)).toEqual(
      livenessPerRun.slice(0, EXAMPLES).map(n => Math.max(n, 1))
    )
    expect(livenessPerRun.length).toBeGreaterThan(EXAMPLES)
  }, 900_000)
})
