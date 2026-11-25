import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Pool } from 'pg'
import type { GfsKey } from '../src/services/gfsWatch/keys.js'
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

// Model-based tests of the authorization window and the fail-closed (T-M3,
// T-SB80) on the real registry: real Postgres with the real gfs_authz_changed
// and gfs_resource_changed triggers fed by real writes (grants through the
// grant route's writer, memberships through the directory service, admins,
// moves and soft deletes of the tree), the expansion on the real watch pool,
// real sessions, mint and readGfsc against the stand-in gfsc. fc.scheduler
// decides when each expansion query is let through; fc.commands interleaves
// opens, departures, writes, window advances, expansion failures and listener
// losses with them.
//
// Reference model, deliberately trivial: in-memory mirrors of the grants,
// memberships, links and tree say what each write affects — users for an
// authorization write, the connections whose accepted key has the moved rid
// in its chain for an ancestry change. A write is pending from just before it
// until the registry is next seen quiet (no window, retry or fail-closed armed
// and no expansion in flight) or loses its listener.
//
// Checked at rest: I5 (every connection a write affected, admitted or ready
// before it, is closed), I11 (no frame names an id; closing frames carry only
// their reason), I12 (a reauthorize reaches a connection only while a write
// that affects it is pending, or a fail-closed is), I35 (no hold, no
// fail-closed reason) and I38 (every pending timer has its handle). I36 and
// the handle half of I38 are checked after every command.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const CLOSING_KEYS = new Set(['schemaVersion', 'type', 'reason', 'retryAfterMs'])

type ConnModel = {
  user: number
  socket: FakeSocket
  outcome: WatchOpenOutcome | null
}

type ModelEvent =
  | { kind: 'authz'; affected: Set<number> }
  | { kind: 'a1'; x: string }
  | { kind: 'failclosed' }
  | { kind: 'loss' }

type PendingEvent = ModelEvent & {
  what: string
  evBefore: number
  evAfter: number
  /** First event number at which the write is known applied or dropped. */
  applied: number | null
}

type Tables = {
  /** `${user}:${file}` → grant id */
  userGrants: Map<string, string>
  /** file → grant id of the shared team's grant */
  teamGrants: Map<number, string>
  /** users that are active members of the shared team */
  members: Set<number>
  /** admin index → user index of its active link */
  activeLinks: Map<number, number>
}

/**
 * The tree from just before the write that produced it (`ev`) on. Until its
 * NOTIFY has been dispatched (`settled`), a decision may still carry the
 * previous chain.
 */
type TreeSnapshot = {
  ev: number
  settled: number
  parent: Map<string, string | null>
  deleted: Set<string>
}

type Real = {
  b: BuiltRegistry
  s: fc.Scheduler
  conns: ConnModel[]
  events: PendingEvent[]
  failEvs: number[]
  failures: string[]
}

describeRealPostgres('GFS watch authorization window model (T-M3, T-SB80)', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let users: TestUser[]
  let team: string
  let admins: string[]
  let dirs: string[]
  let files: string[]
  let tables: Tables
  const tree: TreeSnapshot[] = []
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
    users = [await h.createUser(), await h.createUser(), await h.createUser()]
    team = await h.authz.createTeam()
    await h.authz.join(team, users[0]!.userId)
    await h.authz.join(team, users[1]!.userId)
    admins = [await h.authz.createAdmin(), await h.authz.createAdmin()]
    // Admin 0 is linked to user 2; admin 1's link to user 1 is revoked history.
    await h.authz.link(users[2]!.userId, admins[0]!)
    await h.authz.link(users[1]!.userId, admins[1]!)
    await h.authz.unlink(users[1]!.userId, admins[1]!)
    // root ⊃ D0 ⊃ f0, root ⊃ D1 ⊃ f1, root ⊃ f2
    dirs = [await h.tree.add('directory'), await h.tree.add('directory')]
    files = [
      await h.tree.add('file', dirs[0]),
      await h.tree.add('file', dirs[1]),
      await h.tree.add('file'),
    ]
    tree.push({
      ev: 0,
      settled: 0,
      parent: new Map<string, string | null>([
        [h.tree.root, null],
        [dirs[0]!, h.tree.root],
        [dirs[1]!, h.tree.root],
        [files[0]!, dirs[0]!],
        [files[1]!, dirs[1]!],
        [files[2]!, h.tree.root],
      ]),
      deleted: new Set(),
    })
    tables = {
      userGrants: new Map(),
      teamGrants: new Map(),
      members: new Set([0, 1]),
      activeLinks: new Map([[0, 2]]),
    }
    process.on('unhandledRejection', onUnhandled)
    process.on('uncaughtException', onUnhandled)
  }, 120_000)

  afterAll(async () => {
    try {
      process.off('unhandledRejection', onUnhandled)
      process.off('uncaughtException', onUnhandled)
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

  const keyOf = (i: number) => h.key('file', files[i % files.length]!) as GfsKey
  const fileOfKey = (k: string) => files.find(f => k.endsWith(h.toRid(f)))!

  // ─── Tree model ──────────────────────────────────────────────────────────

  const currentTree = () => tree.at(-1)!

  /** The trees a decision taken at `ev` may have read: one, or two around a tree write. */
  function treesAt(ev: number): TreeSnapshot[] {
    const i = tree.findLastIndex(t => t.ev <= ev)
    const t = tree[Math.max(0, i)]!
    return i > 0 && ev <= t.settled ? [tree[i - 1]!, t] : [t]
  }

  /** The ancestry query's chain: the resource, then each live ancestor, cut at a tombstone. */
  function chainOf(t: TreeSnapshot, id: string): string[] {
    const out = [h.toRid(id)]
    let p = t.parent.get(id) ?? null
    while (p !== null && !t.deleted.has(p)) {
      out.push(h.toRid(p))
      p = t.parent.get(p) ?? null
    }
    return out
  }

  // ─── Invariant predicates ────────────────────────────────────────────────

  function i36(b: BuiltRegistry): string[] {
    const st = b.registry.state
    const pending = st.windows().failClosedPending
    const v: string[] = []
    for (const [uid, n] of st.holdUsers) {
      if (n !== (pending.has(uid) ? 1 : 0)) v.push(`I36: ${uid} held ${n}`)
    }
    for (const uid of pending) if (st.holdUsers.get(uid) !== 1) v.push(`I36: ${uid} not held`)
    return v
  }

  /** Each window handle is set iff its timer is pending. */
  function i38Handles(b: BuiltRegistry): string[] {
    const w = b.registry.state.windows()
    const v: string[] = []
    for (const name of ['authzWindow', 'expansionRetry', 'failClosedTimer'] as const) {
      const handle = w[name]
      if ((handle !== null) !== b.clock.isPending(handle)) v.push(`I38: ${name} handle/pending`)
    }
    return v
  }

  /** At rest: every pending timer is accounted for by exactly one handle. */
  function i38Count(b: BuiltRegistry): string[] {
    const st = b.registry.state
    const w = st.windows()
    let expected = 0
    const l = st.listener
    for (const t of [l.pingInterval, l.echoInterval, l.tConnect, l.reconnectTimer]) {
      if (t !== null) expected += 1
    }
    for (const t of [w.authzWindow, w.expansionRetry, w.failClosedTimer])
      if (t !== null) expected += 1
    for (const conn of st.byConnId.values()) {
      for (const t of Object.values(conn.timers)) if (t !== null) expected += 1
      if (conn.op) expected += (conn.op.tAuth ? 1 : 0) + (conn.op.tSrv ? 1 : 0)
    }
    const pending = b.clock.pendingCount()
    return pending === expected ? [] : [`I38: ${pending} timers pending, ${expected} handles`]
  }

  function i35(b: BuiltRegistry): string[] {
    const st = b.registry.state
    const v: string[] = []
    if (st.holdUsers.size > 0) v.push(`I35: holdUsers ${[...st.holdUsers.keys()]}`)
    if (st.windows().failClosedPending.size > 0) v.push('I35: failClosedPending')
    return v
  }

  /** Nothing armed, nothing to flush and no expansion in flight: every earlier write is applied. */
  function quiet(b: BuiltRegistry): boolean {
    const w = b.registry.state.windows()
    return (
      w.authzWindow === null &&
      w.expansionRetry === null &&
      w.failClosedTimer === null &&
      w.reauthUsers.size === 0 &&
      w.reauthConns.size === 0 &&
      b.gates.expansion.calls === b.gates.expansion.done
    )
  }

  function markApplied(real: Real): void {
    const ev = nextEv()
    for (const e of real.events) if (e.applied === null) e.applied = ev
  }

  // ─── Commands ────────────────────────────────────────────────────────────

  async function record(real: Real, what: string, event: ModelEvent, f: () => Promise<void>) {
    const evBefore = nextEv()
    await f()
    await h.barrier()
    real.events.push({ ...event, what, evBefore, evAfter: nextEv(), applied: null })
  }

  class OpenCmd implements fc.AsyncCommand<object, Real> {
    constructor(
      readonly user: number,
      readonly keys: number[]
    ) {}
    check = () => true
    async run(_m: object, real: Real) {
      const o = real.b.open(users[this.user]!, [...new Set(this.keys.map(keyOf))])
      const m: ConnModel = { user: this.user, socket: o.socket, outcome: null }
      real.conns.push(m)
      void o.outcome.then(out => {
        m.outcome = out
      })
      await sleep(2)
    }
    toString = () => `Open(u${this.user}, ${this.keys})`
  }

  class GoneCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly conn: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      if (real.conns.length) real.conns[this.conn % real.conns.length]!.socket.emitGone()
    }
    toString = () => `Gone(${this.conn})`
  }

  class UserGrantCmd implements fc.AsyncCommand<object, Real> {
    constructor(
      readonly user: number,
      readonly file: number
    ) {}
    check = () => true
    async run(_m: object, real: Real) {
      const k = `${this.user}:${this.file}`
      const existing = tables.userGrants.get(k)
      await record(
        real,
        `UserGrant(${k})`,
        { kind: 'authz', affected: new Set([this.user]) },
        async () => {
          if (existing) {
            await h.authz.revoke(existing)
            tables.userGrants.delete(k)
          } else {
            tables.userGrants.set(
              k,
              await h.authz.grant(files[this.file]!, 'user', users[this.user]!.userId)
            )
          }
        }
      )
    }
    toString = () => `UserGrant(u${this.user}, f${this.file})`
  }

  class TeamGrantCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly file: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const existing = tables.teamGrants.get(this.file)
      const affected = new Set(tables.members)
      await record(real, `TeamGrant(${this.file})`, { kind: 'authz', affected }, async () => {
        if (existing) {
          await h.authz.revoke(existing)
          tables.teamGrants.delete(this.file)
        } else {
          tables.teamGrants.set(this.file, await h.authz.grant(files[this.file]!, 'team', team))
        }
      })
    }
    toString = () => `TeamGrant(f${this.file})`
  }

  class OtherSubjectCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      await record(real, 'HostGrant', { kind: 'authz', affected: new Set() }, async () => {
        await h.authz.grant(await h.tree.add('file'), 'host', 'host-model')
      })
    }
    toString = () => 'HostGrant'
  }

  class MembershipCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly user: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const member = tables.members.has(this.user)
      await record(
        real,
        `Membership(${this.user})`,
        { kind: 'authz', affected: new Set([this.user]) },
        async () => {
          if (member) {
            await h.authz.leave(team, users[this.user]!.userId)
            tables.members.delete(this.user)
          } else {
            await h.authz.join(team, users[this.user]!.userId)
            tables.members.add(this.user)
          }
        }
      )
    }
    toString = () => `Membership(u${this.user})`
  }

  class AdminCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly admin: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const linked = tables.activeLinks.get(this.admin)
      await record(
        real,
        `Admin(${this.admin})`,
        { kind: 'authz', affected: new Set(linked === undefined ? [] : [linked]) },
        () => h.authz.bumpAdmin(admins[this.admin]!)
      )
    }
    toString = () => `Admin(a${this.admin})`
  }

  /** Moves a directory under the root or under the other one (never into its own subtree). */
  class MoveCmd implements fc.AsyncCommand<object, Real> {
    constructor(
      readonly dir: number,
      readonly underOther: boolean
    ) {}
    check = () => true
    async run(_m: object, real: Real) {
      const d = dirs[this.dir]!
      const other = dirs[1 - this.dir]!
      const t = currentTree()
      const target = this.underOther ? other : h.tree.root
      if (t.parent.get(d) === target || (this.underOther && t.parent.get(other) === d)) return
      const evBefore = nextEv()
      const parent = new Map(t.parent).set(d, target)
      const snap = {
        ev: evBefore,
        settled: Number.POSITIVE_INFINITY,
        parent,
        deleted: new Set(t.deleted),
      }
      tree.push(snap)
      await h.tree.move(d, target)
      await h.barrier()
      snap.settled = nextEv()
      real.events.push({
        kind: 'a1',
        x: h.toRid(d),
        what: `Move(D${this.dir})`,
        evBefore,
        evAfter: nextEv(),
        applied: null,
      })
    }
    toString = () => `Move(D${this.dir} → ${this.underOther ? 'other' : 'root'})`
  }

  /**
   * Soft-deletes a directory (a = 1). Never restores it while streams are
   * open: no production writer restores a resource, and a restore that
   * commits between an open's ancestry query and its decision leaves the key
   * accepted with the cut chain, which a later change of the restored node
   * does not reach. Restores happen between runs, with no registry running.
   */
  class SoftDeleteCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly dir: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const d = dirs[this.dir]!
      const t = currentTree()
      if (t.deleted.has(d)) return
      const evBefore = nextEv()
      const snap = {
        ev: evBefore,
        settled: Number.POSITIVE_INFINITY,
        parent: new Map(t.parent),
        deleted: new Set([...t.deleted, d]),
      }
      tree.push(snap)
      await h.tree.softDelete(d)
      await h.barrier()
      snap.settled = nextEv()
      real.events.push({
        kind: 'a1',
        x: h.toRid(d),
        what: `SoftDelete(D${this.dir})`,
        evBefore,
        evAfter: nextEv(),
        applied: null,
      })
    }
    toString = () => `SoftDelete(D${this.dir})`
  }

  /** Restores every soft-deleted directory before a run builds its registry. */
  async function restoreTree(): Promise<void> {
    const t = currentTree()
    if (t.deleted.size === 0) return
    await h.writer.query(
      `UPDATE gfs_resources SET deleted_at = NULL WHERE resource_id = ANY($1::uuid[])`,
      [[...t.deleted]]
    )
    const ev = nextEv()
    tree.push({ ev, settled: ev, parent: new Map(t.parent), deleted: new Set() })
  }

  class ListenerLossCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      const evBefore = nextEv()
      const terminated = await h.terminateListener()
      for (let i = 0; i < 400 && real.b.registry.listenerReady(); i += 1) await sleep(5)
      if (terminated !== 1 || real.b.registry.listenerReady()) {
        real.failures.push(`harness: listener loss not induced (${terminated} backends ended)`)
        return
      }
      // E11 drops every window and pending reason; what was pending no longer applies.
      markApplied(real)
      real.events.push({
        kind: 'loss',
        what: 'ListenerLoss',
        evBefore,
        evAfter: nextEv(),
        applied: nextEv(),
      })
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

  /** Lets every open in progress finish, so later writes meet ready streams. */
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

  class ExpansionFailCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly n: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const gate = real.b.gates.expansion
      let left = this.n
      gate.failWith = () => {
        left -= 1
        if (left <= 0) gate.mode = 'pass'
        real.failEvs.push(nextEv())
        return new Error('Connection terminated unexpectedly')
      }
      gate.mode = 'fail'
    }
    toString = () => `ExpansionFail(${this.n})`
  }

  // ─── Rest ────────────────────────────────────────────────────────────────

  /** No scheduled step, no op, no open and no expansion in flight. */
  async function settle(real: Real, rounds = 300): Promise<void> {
    const idle = () =>
      real.s.count() === 0 &&
      real.b.registry.state.opsInFlight.size === 0 &&
      !real.conns.some(c => c.outcome === null) &&
      real.b.gates.expansion.calls === real.b.gates.expansion.done
    for (let i = 0; i < rounds; i += 1) {
      if (real.s.count() > 0) await real.s.waitAll()
      await sleep(3)
      await flushMicrotasks()
      if (idle()) {
        await sleep(5)
        await flushMicrotasks()
        if (idle()) return
      }
    }
    throw new Error('model run did not reach rest')
  }

  const failclosedTotal = async () =>
    (await h.modules.metrics.gfsWatchExpansionFailclosedTotal.get()).values.reduce(
      (n, x) => n + x.value,
      0
    )

  /** Runs one step and records a fail-closed it triggered as a pending event. */
  async function step(real: Real, what: string, f: () => Promise<void>): Promise<void> {
    const evStart = nextEv()
    const before = await failclosedTotal()
    await f()
    await flushMicrotasks()
    if ((await failclosedTotal()) > before) {
      real.events.push({
        kind: 'failclosed',
        what: `FailClosed during ${what}`,
        evBefore: evStart,
        evAfter: nextEv(),
        applied: null,
      })
    }
    if (quiet(real.b)) markApplied(real)
  }

  /** Drains every window, retry and fail-closed ceiling, then waits for quiet. */
  async function rest(real: Real): Promise<void> {
    real.b.gates.expansion.mode = 'pass'
    await step(real, 'rest', () => settle(real))
    for (const ms of [300, 600, 300, 5_100, 300]) {
      await step(real, `rest +${ms}`, async () => {
        await real.b.advance(ms)
        await settle(real)
      })
    }
    for (let i = 0; i < 20 && !quiet(real.b); i += 1) {
      await step(real, 'rest +600', async () => {
        await real.b.advance(600)
        await settle(real)
      })
    }
    if (!quiet(real.b)) throw new Error('registry windows did not drain')
    markApplied(real)
  }

  // ─── Reference model ─────────────────────────────────────────────────────

  type Frames = { evs?: number[] }

  function readyOf(m: ConnModel): { ev: number; accepted: string[] } | null {
    const evs = (m.socket as FakeSocket & Frames).evs ?? []
    const i = m.socket.frames.findIndex(f => f.type === 'ready')
    return i < 0 ? null : { ev: evs[i] ?? 0, accepted: m.socket.frames[i]!.accepted as string[] }
  }

  /**
   * Connections an ancestry change of x can reach: an accepted key with x in
   * its chain. `may` takes any tree the decision could have read (to explain
   * a close), `must` only what every such tree agrees on (to demand one).
   */
  function a1Reaches(m: ConnModel, x: string, readyBefore: number, mode: 'may' | 'must'): boolean {
    const r = readyOf(m)
    if (!r || r.ev >= readyBefore) return false
    const hit = (t: TreeSnapshot) => r.accepted.some(k => chainOf(t, fileOfKey(k)).includes(x))
    const trees = treesAt(r.ev)
    return mode === 'may' ? trees.some(hit) : trees.every(hit)
  }

  function affects(e: PendingEvent, m: ConnModel, mode: 'may' | 'must'): boolean {
    if (e.kind === 'authz') return e.affected.has(m.user)
    if (e.kind === 'a1') return a1Reaches(m, e.x, e.evAfter, mode)
    return true
  }

  function checkModel(real: Real): { violations: string[]; a1Closes: number } {
    const v: string[] = []
    let a1Closes = 0
    const ids = [team, ...admins, ...users.map(u => u.userId)]
    for (const m of real.conns) {
      const conn = real.b.connOf(m.socket)
      const admitted = m.socket.admittedEv
      if (m.outcome === null) v.push('open did not resolve')
      // I5: an affected connection that existed before the write is closed.
      for (const e of real.events) {
        if (admitted === null || !affects(e, m, 'must')) continue
        const before = e.kind === 'a1' ? readyOf(m)!.ev < e.evBefore : admitted < e.evBefore
        if (before && conn && conn.phase !== 'closed') {
          v.push(`I5: u${m.user} conn admitted at ${admitted} open after ${e.what}`)
        }
      }
      // I11
      for (const f of m.socket.frames) {
        const json = JSON.stringify(f)
        for (const id of ids) if (json.includes(id)) v.push(`I11: ${String(f.type)} names ${id}`)
      }
      // I12: each reauthorize is explained by a write still pending for this connection.
      const evs = (m.socket as FakeSocket & Frames).evs ?? []
      m.socket.frames.forEach((f, i) => {
        if (f.type !== 'stream.closing') return
        for (const k of Object.keys(f)) if (!CLOSING_KEYS.has(k)) v.push(`I11: closing has ${k}`)
        if (f.reason !== 'reauthorize') return
        const ev = evs[i] ?? 0
        const causes = real.events.filter(
          e =>
            e.kind !== 'loss' &&
            e.evBefore < ev &&
            affects(e, m, 'may') &&
            admitted !== null &&
            admitted < (e.applied ?? Number.POSITIVE_INFINITY)
        )
        if (causes.length === 0) {
          v.push(`I12: u${m.user} reauthorized at ${ev} with no pending write affecting it`)
        } else if (causes.every(e => e.kind === 'a1')) a1Closes += 1
      })
    }
    return { violations: v, a1Closes }
  }

  function trackFrames(socket: FakeSocket): void {
    const evs: number[] = []
    ;(socket as FakeSocket & Frames).evs = evs
    socket.onFrame = (_f, ev) => evs.push(ev)
  }

  const coverage = {
    reauthorize: 0,
    reauthorizeByAncestry: 0,
    failclosed: 0,
    expansions: 0,
    openRefused: 0,
    listenerLoss: 0,
  }

  const userIdx = fc.nat(2)
  const commands = [
    fc
      .tuple(userIdx, fc.array(fc.nat(2), { minLength: 1, maxLength: 3 }))
      .map(([u, k]) => new OpenCmd(u, k)),
    fc
      .tuple(userIdx, fc.array(fc.nat(2), { minLength: 1, maxLength: 3 }))
      .map(([u, k]) => new OpenCmd(u, k)),
    fc.constant(new SettleOpensCmd()),
    fc.constant(new SettleOpensCmd()),
    fc.nat(5).map(c => new GoneCmd(c)),
    fc.tuple(userIdx, fc.nat(2)).map(([u, f]) => new UserGrantCmd(u, f)),
    fc.nat(2).map(f => new TeamGrantCmd(f)),
    fc.constant(new OtherSubjectCmd()),
    userIdx.map(u => new MembershipCmd(u)),
    fc.nat(1).map(a => new AdminCmd(a)),
    fc.tuple(fc.nat(1), fc.boolean()).map(([d, o]) => new MoveCmd(d, o)),
    fc.nat(1).map(d => new SoftDeleteCmd(d)),
    fc.constant(new ListenerLossCmd()),
    fc.constantFrom(250, 600, 5_000, 6_500).map(ms => new AdvanceCmd(ms)),
    fc.integer({ min: 1, max: 4 }).map(n => new StepCmd(n)),
    fc.integer({ min: 1, max: 2 }).map(n => new ExpansionFailCmd(n)),
  ]

  it('T-M3: keeps I5, I11, I12, I35, I36 and I38 under scheduled expansions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(commands, { maxCommands: 20, size: 'large' }),
        async (s, cmds) => {
          h.decisions.clear()
          await restoreTree()
          const b = await h.build()
          const real: Real = { b, s, conns: [], events: [], failEvs: [], failures: [] }
          b.gates.expansion.hook = label => s.schedule(Promise.resolve(label)).then(() => undefined)
          const origOpen = b.open.bind(b)
          b.open = (...args) => {
            const r = origOpen(...args)
            trackFrames(r.socket)
            return r
          }
          const fc0 = await failclosedTotal()
          const exp0 = b.gates.expansion.done
          let stopped = false
          const stop = async () => {
            if (stopped) return
            stopped = true
            b.gates.expansion.hook = null
            await b.stop()
          }
          try {
            const wrapped = [...cmds].map(c => ({
              check: () => true,
              run: async (m: object, r: Real) => {
                await step(r, c.toString(), () => c.run(m, r))
                r.failures.push(...i36(r.b).map(x => `${x} after ${c.toString()}`))
                r.failures.push(...i38Handles(r.b).map(x => `${x} after ${c.toString()}`))
              },
              toString: () => c.toString(),
            }))
            await fc.asyncModelRun(() => ({ model: {}, real }), wrapped)
            await rest(real)
            const closed = real.conns.flatMap(c => {
              const conn = b.connOf(c.socket)
              return conn && conn.phase === 'closed' ? [conn] : []
            })
            const model = checkModel(real)
            // The rest state and the model are read before stop, which closes
            // every stream; the socket checks after it, so its writes count.
            const atRest = [
              ...real.failures,
              ...restInvariantViolations(b, closed),
              ...model.violations,
              ...i35(b),
              ...i36(b),
              ...i38Handles(b),
              ...i38Count(b),
            ]
            for (const m of real.conns) {
              coverage.reauthorize += m.socket
                .framesOf('stream.closing')
                .filter(f => f.reason === 'reauthorize').length
              if (m.outcome?.kind === 'reply' && m.outcome.code === 'watch_reauthorize') {
                coverage.openRefused += 1
              }
            }
            coverage.reauthorizeByAncestry += model.a1Closes
            coverage.listenerLoss += real.events.filter(e => e.kind === 'loss').length
            coverage.failclosed += (await failclosedTotal()) - fc0
            coverage.expansions += b.gates.expansion.done - exp0
            await stop()
            const violations = [
              ...atRest,
              ...b.violations(),
              ...unhandled.map(e => `unhandled: ${String(e)}`),
            ]
            unhandled = []
            expect(violations).toEqual([])
          } finally {
            await stop()
          }
        }
      ),
      {
        numRuns: Number(process.env.GFS_WATCH_MODEL_RUNS ?? 40) + 4,
        endOnFailure: true,
        verbose: 1,
        // Fixed sequences that reach every path regardless of what the random
        // runs draw: a team expansion held by the scheduler while the member
        // opens again; direct, membership and admin writes; two failed
        // expansions that fail closed; an ancestry change of an accepted key
        // and a listener loss with writes pending; and a reauthorized user who
        // reopens before an unrelated write.
        examples: [
          [
            fc.sample(fc.scheduler(), { seed: 7, numRuns: 1 })[0]!,
            [
              new OpenCmd(0, [0]),
              new OpenCmd(1, [1]),
              new OpenCmd(2, [2]),
              new SettleOpensCmd(),
              new AdvanceCmd(250),
              new TeamGrantCmd(0),
              new AdvanceCmd(250),
              new OpenCmd(0, [1]),
              new StepCmd(2),
              new UserGrantCmd(2, 1),
              new AdminCmd(0),
              new AdminCmd(1),
              new AdvanceCmd(600),
              new MembershipCmd(2),
              new AdvanceCmd(250),
            ] as unknown as Iterable<fc.AsyncCommand<object, Real>>,
          ],
          [
            fc.sample(fc.scheduler(), { seed: 11, numRuns: 1 })[0]!,
            [
              new OpenCmd(0, [0, 1]),
              new OpenCmd(2, [2]),
              new SettleOpensCmd(),
              new AdvanceCmd(250),
              new ExpansionFailCmd(2),
              new TeamGrantCmd(1),
              new AdvanceCmd(250),
              new StepCmd(1),
              new AdvanceCmd(600),
              new StepCmd(1),
              new OpenCmd(1, [0]),
              new AdvanceCmd(5_000),
              new OpenCmd(0, [0]),
              new OtherSubjectCmd(),
              new AdvanceCmd(250),
            ] as unknown as Iterable<fc.AsyncCommand<object, Real>>,
          ],
          [
            fc.sample(fc.scheduler(), { seed: 13, numRuns: 1 })[0]!,
            [
              new OpenCmd(0, [0]),
              new OpenCmd(1, [2]),
              new SettleOpensCmd(),
              new MoveCmd(0, true),
              new AdvanceCmd(250),
              new StepCmd(1),
              new AdvanceCmd(6_500),
              new OpenCmd(0, [0]),
              new SettleOpensCmd(),
              new SoftDeleteCmd(1),
              new UserGrantCmd(1, 2),
              new ListenerLossCmd(),
              new OpenCmd(1, [2]),
              new SettleOpensCmd(),
              new AdvanceCmd(600),
            ] as unknown as Iterable<fc.AsyncCommand<object, Real>>,
          ],
          [
            fc.sample(fc.scheduler(), { seed: 17, numRuns: 1 })[0]!,
            [
              new OpenCmd(0, [2]),
              new OpenCmd(2, [2]),
              new SettleOpensCmd(),
              new UserGrantCmd(0, 2),
              new AdvanceCmd(250),
              new StepCmd(1),
              new OpenCmd(0, [2]),
              new SettleOpensCmd(),
              new UserGrantCmd(2, 0),
              new AdvanceCmd(250),
              new StepCmd(1),
            ] as unknown as Iterable<fc.AsyncCommand<object, Real>>,
          ],
        ],
      }
    )
    expect(Object.entries(coverage).filter(([, n]) => n === 0)).toEqual([])
  }, 900_000)

  // ─── T-SB80 ─────────────────────────────────────────────────────────────

  class AuthzRoundCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      await h.authz.grant(await h.tree.add('file'), 'team', team)
      await h.barrier()
      await real.b.advance(250)
      await sleep(5)
    }
    toString = () => 'AuthzRound(team, +250)'
  }

  class ExpansionModeCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly mode: 'hold' | 'pass') {}
    check = () => true
    async run(_m: object, real: Real) {
      real.b.gates.expansion.mode = this.mode
    }
    toString = () => `ExpansionMode(${this.mode})`
  }

  class TimeoutHeldCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      const d = real.b.gates.expansion.done + real.b.gates.expansion.held.length
      real.b.gates.expansion.failAll(new Error('Query read timeout'))
      await real.b.settle(() => real.b.gates.expansion.done >= d)
    }
    toString = () => 'TimeoutHeld'
  }

  class ReleaseHeldCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      const d = real.b.gates.expansion.done + real.b.gates.expansion.held.length
      real.b.gates.expansion.releaseAll()
      await real.b.settle(() => real.b.gates.expansion.done >= d)
    }
    toString = () => 'ReleaseHeld'
  }

  it('T-SB80: overlapping failed windows leave one retry with one handle; I35, I36, I38 and I24 hold', async () => {
    const roundCmds = [
      fc.constant(new AuthzRoundCmd()),
      fc.constant(new AuthzRoundCmd()),
      fc.constantFrom('hold', 'pass').map(m => new ExpansionModeCmd(m as 'hold' | 'pass')),
      fc.constant(new TimeoutHeldCmd()),
      fc.constant(new ReleaseHeldCmd()),
      fc.constantFrom(250, 500, 5_000).map(ms => new AdvanceCmd(ms)),
    ]
    let retriesSeen = 0
    await fc.assert(
      fc.asyncProperty(fc.commands(roundCmds, { maxCommands: 14 }), async cmds => {
        const b = await h.build()
        const s = fc.sample(fc.scheduler(), { seed: 1, numRuns: 1 })[0]!
        const real: Real = { b, s, conns: [], events: [], failEvs: [], failures: [] }
        try {
          const o = b.open(users[0]!, [keyOf(0)])
          real.conns.push({ user: 0, socket: o.socket, outcome: await o.outcome })
          const wrapped = [...cmds].map(c => ({
            check: () => true,
            run: async (m: object, r: Real) => {
              await c.run(m, r)
              await flushMicrotasks()
              const w = r.b.registry.state.windows()
              if (w.expansionRetry !== null) retriesSeen += 1
              r.failures.push(
                ...[...i36(r.b), ...i38Handles(r.b), ...i38Count(r.b)].map(
                  x => `${x} after ${c.toString()}`
                )
              )
            },
            toString: () => c.toString(),
          }))
          await fc.asyncModelRun(() => ({ model: {}, real }), wrapped)
          b.gates.expansion.mode = 'pass'
          b.gates.expansion.releaseAll()
          await b.settle(() => b.gates.expansion.held.length === 0)
          for (const ms of [300, 600, 5_100, 300]) {
            await b.advance(ms)
            await b.settle()
          }
          const violations = [
            ...real.failures,
            ...i35(b),
            ...i38Count(b),
            ...restInvariantViolations(b),
            ...unhandled.map(e => `unhandled: ${String(e)}`),
          ]
          unhandled = []
          expect(violations).toEqual([])
        } finally {
          await b.stop()
        }
      }),
      {
        numRuns: Number(process.env.GFS_WATCH_MODEL_RUNS ?? 40) + 1,
        endOnFailure: true,
        verbose: 1,
        examples: [
          [
            [
              new ExpansionModeCmd('hold'),
              new AuthzRoundCmd(),
              new AuthzRoundCmd(),
              new TimeoutHeldCmd(),
              new AdvanceCmd(500),
            ] as unknown as Iterable<fc.AsyncCommand<object, Real>>,
          ],
        ],
      }
    )
    expect(retriesSeen).toBeGreaterThan(0)
  }, 900_000)
})
