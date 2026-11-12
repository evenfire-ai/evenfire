import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { GfsKey, Uuid } from '../src/services/gfsWatch/keys.js'
import type { WatchConnection, WatchOpenOutcome } from '../src/services/gfsWatch/registry.js'
import { registryTestDatabase } from './helpers/gfsWatchRegistryEnv.js'
import type {
  BuiltRegistry,
  FakeSocket,
  GfscDecision,
  RegistryHarness,
  TestUser,
} from './helpers/gfsWatchRegistryHarness.js'
import { type Loaded, loadHelpers } from './helpers/gfsWatchRegistryLoad.js'
import './realPostgres.requirement.ts'

// src/db.ts reads its connection string when first evaluated, and the
// harness and clock reach it through their static imports. They are loaded
// only after the static import of the env helper above has pointed the core
// pool at this suite's database; a static import would let the import sorter
// place them ahead of it.
let flushMicrotasks!: Loaded['flushMicrotasks'],
  createRegistryHarness!: Loaded['createRegistryHarness'],
  nextEv!: Loaded['nextEv'],
  quoteIdent!: Loaded['quoteIdent'],
  restInvariantViolations!: Loaded['restInvariantViolations'],
  sleep!: Loaded['sleep']

// Model-based test of the GFS watch registry (§2–§3) on the real stack: real
// Postgres with the dedicated LISTEN and the real resource trigger, real
// sessions, mint and readGfsc, and a stand-in gfsc that answers with gfsc's
// own envelope. fc.scheduler decides the order in which the ancestry query,
// every mint and every gfsc read are let through; fc.commands interleaves
// opens, routed commands (valid, duplicated, out of order, forged), moves,
// renames, decision changes, client departures, T_auth, query failures and
// listener losses with them.
//
// Reference model, deliberately trivial: a key may be `accepted` only if the
// last read of its resource by the op that accepted it was a 2xx of the right
// kind under an `allow` decision, and no ancestry change of its chain landed
// within the six seconds before that op started or while it ran. Everything
// else is checked as an invariant at rest.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

type ConnModel = {
  user: TestUser
  socket: FakeSocket
  outcome: WatchOpenOutcome | null
  conn: WatchConnection | undefined
  openKeys: GfsKey[]
  /** seq → keys and the issue instant of every legitimate command sent. */
  puts: Map<number, { keys: GfsKey[]; vt: number; r: string }>
  openVt: number
  openRequestId: string
  maxSeq: number
  lastSeqSeen: number
  /** Decision frames with their event number. */
  decisions: { frame: Record<string, unknown>; ev: number }[]
}

type Real = {
  b: BuiltRegistry
  s: fc.Scheduler
  users: TestUser[]
  conns: ConnModel[]
  moves: { rid32: string; ev: number; vt: number }[]
  fixture: Fixture
  failures: string[]
  pParent: string
}

type Fixture = {
  p: string
  q: string
  f1: string
  f2: string
  g: string
  denied: string
  keys: GfsKey[]
  kindOf: Map<string, 'file' | 'dir'>
}

describeRealPostgres('GFS watch registry model (T-M2)', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let users: TestUser[]
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
    users = [await h.createUser(), await h.createUser()]
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

  async function fixture(): Promise<Fixture> {
    const p = await h.tree.add('directory')
    const q = await h.tree.add('directory')
    const f1 = await h.tree.add('file', p)
    const f2 = await h.tree.add('file', p)
    const g = await h.tree.add('file')
    const denied = await h.tree.add('file', p)
    const missing = randomUUID()
    const kindOf = new Map<string, 'file' | 'dir'>([
      [h.toRid(p), 'dir'],
      [h.toRid(q), 'dir'],
      [h.toRid(f1), 'file'],
      [h.toRid(f2), 'file'],
      [h.toRid(g), 'file'],
      [h.toRid(denied), 'file'],
    ])
    return {
      p,
      q,
      f1,
      f2,
      g,
      denied,
      kindOf,
      keys: [
        h.key('dir', p),
        h.key('file', f1),
        h.key('file', f2),
        h.key('file', g),
        h.key('file', denied),
        h.key('file', missing),
        h.key('file', p),
        h.key('dir', q),
      ],
    }
  }

  const pick = (fx: Fixture, idx: number[]) => [
    ...new Set(idx.map(i => fx.keys[i % fx.keys.length]!)),
  ]

  function track(real: Real, m: ConnModel): void {
    m.socket.onFrame = (frame, ev) => {
      if (frame.type === 'ready' || frame.type === 'subscriptions') m.decisions.push({ frame, ev })
    }
  }

  async function settleScheduler(real: Real, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      if (real.s.count() > 0) await real.s.waitAll()
      await sleep(3)
      await flushMicrotasks()
      const opening = real.conns.some(c => c.outcome === null)
      if (real.s.count() === 0 && real.b.registry.state.opsInFlight.size === 0 && !opening) {
        await sleep(5)
        if (real.s.count() === 0 && real.b.registry.state.opsInFlight.size === 0) return
      }
    }
    throw new Error('model run did not reach rest')
  }

  class OpenCmd implements fc.AsyncCommand<object, Real> {
    constructor(
      readonly user: number,
      readonly keys: number[]
    ) {}
    check = () => true
    async run(_m: object, real: Real) {
      const requestId = randomUUID()
      const o = real.b.open(real.users[this.user]!, pick(real.fixture, this.keys), { requestId })
      const m: ConnModel = {
        user: real.users[this.user]!,
        socket: o.socket,
        outcome: null,
        conn: undefined,
        openKeys: pick(real.fixture, this.keys),
        puts: new Map(),
        openVt: real.b.clock.now(),
        openRequestId: requestId,
        maxSeq: 0,
        lastSeqSeen: 0,
        decisions: [],
      }
      track(real, m)
      real.conns.push(m)
      void o.outcome.then(out => {
        m.outcome = out
        m.conn = real.b.connOf(o.socket)
      })
      await sleep(2)
      m.conn = real.b.connOf(o.socket)
    }
    toString = () => `Open(u${this.user}, ${this.keys})`
  }

  function connAt(real: Real, i: number): ConnModel | undefined {
    const ready = real.conns.filter(c => c.conn?.phase === 'ready')
    return ready.length ? ready[i % ready.length] : undefined
  }

  class PutCmd implements fc.AsyncCommand<object, Real> {
    constructor(
      readonly conn: number,
      readonly keys: number[],
      readonly variant: 'next' | 'dup' | 'older' | 'jump' | 'foreign' | 'gen'
    ) {}
    check = () => true
    async run(_m: object, real: Real) {
      const c = connAt(real, this.conn)
      if (!c?.conn) return
      const keys = pick(real.fixture, this.keys)
      const r = randomUUID()
      let s = c.maxSeq + 1
      let u = c.conn.binding.userId
      let g = c.conn.binding.authGeneration
      let legit = true
      if (this.variant === 'dup') s = Math.max(1, c.maxSeq)
      if (this.variant === 'older') s = Math.max(1, c.maxSeq - 1)
      if (this.variant === 'jump') s = c.maxSeq + 2_000
      if (this.variant === 'foreign') u = real.users.find(x => x.userId !== u)!.userId
      if (this.variant === 'gen') g += 1
      if (this.variant !== 'next') legit = this.variant === 'dup' || this.variant === 'older'
      if (legit) c.maxSeq = Math.max(c.maxSeq, s)
      if (legit && !c.puts.has(s)) c.puts.set(s, { keys, vt: real.b.clock.now(), r })
      await h.notifyCmd({ c: c.conn.connId, s, u, g, r: r as Uuid, keys: new Set(keys) })
      if (c.conn.lastSeq < c.lastSeqSeen)
        real.failures.push(`I40: lastSeq decreased on ${c.conn.connId}`)
      c.lastSeqSeen = c.conn.lastSeq
      if (c.conn.lastSeq > c.maxSeq)
        real.failures.push(`I19/I40: lastSeq ${c.conn.lastSeq} beyond ${c.maxSeq}`)
    }
    toString = () => `Put(c${this.conn}, ${this.variant}, ${this.keys})`
  }

  class MoveCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly toQ: boolean) {}
    check = () => true
    async run(_m: object, real: Real) {
      const { p, q } = real.fixture
      const target = this.toQ ? q : h.tree.root
      await h.tree.move(p, target)
      await h.barrier()
      // Same parent: the trigger reports no ancestry change (a = 0).
      if (real.pParent !== target) {
        real.moves.push({ rid32: h.toRid(p), ev: nextEv(), vt: real.b.clock.now() })
      }
      real.pParent = target
    }
    toString = () => `Move(P → ${this.toQ ? 'Q' : 'root'})`
  }

  class RenameCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly which: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const fx = real.fixture
      await h.tree.rename([fx.f1, fx.f2, fx.g, fx.p][this.which % 4]!)
      await h.barrier()
    }
    toString = () => `Rename(${this.which})`
  }

  class DecisionCmd implements fc.AsyncCommand<object, Real> {
    constructor(
      readonly which: number,
      readonly decision: GfscDecision
    ) {}
    check = () => true
    async run(_m: object, real: Real) {
      const fx = real.fixture
      h.decisions.set(h.toRid([fx.f1, fx.g, fx.p][this.which % 3]!), this.decision)
    }
    toString = () => `Decision(${this.which}, ${this.decision})`
  }

  class GoneCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly conn: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      const c = real.conns.length ? real.conns[this.conn % real.conns.length] : undefined
      c?.socket.emitGone()
    }
    toString = () => `Gone(${this.conn})`
  }

  class StepCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly n: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      for (let i = 0; i < this.n; i += 1) {
        if (real.s.count() > 0) await real.s.waitOne()
        await sleep(4)
      }
    }
    toString = () => `Step(${this.n})`
  }

  class SettleCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      for (let i = 0; i < 50; i += 1) {
        if (real.s.count() > 0) await real.s.waitAll()
        await sleep(4)
        if (real.s.count() === 0 && real.b.registry.state.opsInFlight.size === 0) break
      }
    }
    toString = () => 'Settle'
  }

  class AdvanceCmd implements fc.AsyncCommand<object, Real> {
    constructor(readonly ms: number) {}
    check = () => true
    async run(_m: object, real: Real) {
      await real.b.advance(this.ms)
    }
    toString = () => `Advance(${this.ms})`
  }

  class CteFailCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      const gate = real.b.gates.cte
      gate.failWith = () => {
        gate.mode = 'pass'
        return new Error('Connection terminated unexpectedly')
      }
      gate.mode = 'fail'
    }
    toString = () => 'CteFail'
  }

  class ListenerLostCmd implements fc.AsyncCommand<object, Real> {
    check = () => true
    async run(_m: object, real: Real) {
      await adminPool!.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND query LIKE 'LISTEN gfs_resource_changed%'`,
        [registryTestDatabase]
      )
      for (let i = 0; i < 400 && real.b.registry.listenerReady(); i += 1) await sleep(5)
      real.b.clock.advance(1_200)
      for (let i = 0; i < 1_000 && !real.b.registry.listenerReady(); i += 1) await sleep(5)
    }
    toString = () => 'ListenerLost'
  }

  const keyIdx = fc.array(fc.nat(7), { maxLength: 5 })
  const commands = [
    fc.tuple(fc.nat(1), keyIdx).map(([u, k]) => new OpenCmd(u, k)),
    fc.tuple(fc.nat(1), keyIdx).map(([u, k]) => new OpenCmd(u, k)),
    fc.constant(new SettleCmd()),
    fc.constant(new SettleCmd()),
    fc
      .tuple(
        fc.nat(3),
        keyIdx,
        fc.constantFrom('next', 'next', 'next', 'dup', 'older', 'jump', 'foreign', 'gen')
      )
      .map(([c, k, v]) => new PutCmd(c, k, v as PutCmd['variant'])),
    fc.boolean().map(b => new MoveCmd(b)),
    fc.nat(3).map(w => new RenameCmd(w)),
    fc
      .tuple(fc.nat(2), fc.constantFrom<GfscDecision>('allow', 'deny', 'unavailable'))
      .map(([w, d]) => new DecisionCmd(w, d)),
    fc.nat(3).map(c => new GoneCmd(c)),
    fc.integer({ min: 1, max: 6 }).map(n => new StepCmd(n)),
    fc.constantFrom(250, 6_000).map(ms => new AdvanceCmd(ms)),
    fc.constant(new CteFailCmd()),
    fc.constant(new ListenerLostCmd()),
  ]

  function deciderOf(m: ConnModel, k: GfsKey) {
    // The decision frame from which k is accepted without interruption.
    let start: { frame: Record<string, unknown>; ev: number } | null = null
    for (const d of m.decisions) {
      const acc = (d.frame.accepted as string[]).includes(k)
      if (!acc) start = null
      else if (start === null) start = d
    }
    return start
  }

  function checkModel(real: Real): string[] {
    const v: string[] = []
    const fx = real.fixture
    for (const m of real.conns) {
      const conn = m.conn
      if (m.outcome === null) v.push('I30: open did not resolve')
      if (
        m.outcome &&
        m.outcome.kind !== 'stream' &&
        conn &&
        real.b.registry.state.byConnId.get(conn.connId) === conn
      ) {
        v.push(`I30: ${m.outcome.kind} outcome but still admitted`)
      }
      if (!conn || conn.phase !== 'ready') continue
      // The effective set is a subset of the newest applied command's keys.
      const base = conn.lastSeq === 0 ? m.openKeys : m.puts.get(conn.lastSeq)?.keys
      if (!base) v.push(`I19: lastSeq ${conn.lastSeq} never sent legitimately`)
      for (const k of conn.keys.keys())
        if (base && !base.includes(k)) v.push(`I21: ${k} not in set ${conn.lastSeq}`)
      for (const [k, rec] of conn.keys) {
        if (rec.state !== 'accepted') continue
        const r32 = k.slice(k.lastIndexOf('/') + 1)
        const expectedKind = fx.kindOf.get(r32)
        if (expectedKind === undefined || !k.startsWith(`${expectedKind}:`))
          v.push(`I6/I11: ${k} accepted with wrong kind or missing`)
        const d = deciderOf(m, k)
        if (!d) {
          v.push(`I6: ${k} accepted without a decision frame`)
          continue
        }
        const seq = d.frame.type === 'ready' ? 0 : (d.frame.seq as number)
        const opRequestId = seq === 0 ? m.openRequestId : m.puts.get(seq)?.r
        const vt = seq === 0 ? m.openVt : m.puts.get(seq)?.vt
        const reads = h.reads.filter(
          r => r.rid32 === r32 && r.requestId === opRequestId && r.seq < d.ev
        )
        const last = reads.at(-1)
        if (!last || last.status !== 200 || last.decision !== 'allow')
          v.push(`I6: ${k} accepted after read ${JSON.stringify(last)}`)
        const chain = new Set([r32, ...(rec.chain ?? [])])
        for (const mv of real.moves) {
          if (chain.has(mv.rid32) && mv.ev < d.ev && vt !== undefined && mv.vt > vt - 6_000) {
            v.push(`I6/S4: ${k} accepted despite move ev ${mv.ev} before frame ev ${d.ev}`)
          }
        }
      }
    }
    return v
  }

  const coverage = {
    accepted: 0,
    rejected: 0,
    deferred: 0,
    suspect: 0,
    subscriptions: 0,
    closedReady: 0,
  }

  function recordCoverage(real: Real): void {
    for (const m of real.conns) {
      for (const d of m.decisions) {
        coverage.accepted += (d.frame.accepted as unknown[]).length
        coverage.rejected += (d.frame.rejected as unknown[]).length
        coverage.deferred += (d.frame.deferred as unknown[]).length
        if ((d.frame.retryAfterMs as number) >= 6_000) coverage.suspect += 1
        if (d.frame.type === 'subscriptions') coverage.subscriptions += 1
      }
      if (m.socket.framesOf('stream.closing').length > 0) coverage.closedReady += 1
    }
  }

  it('keeps I4, I6, I11, I17, I19, I20, I23–I26, I30, I40 and I42 under scheduled interleavings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(commands, { maxCommands: 24, size: 'large' }),
        async (s, cmds) => {
          h.decisions.clear()
          const b = await h.build()
          const fx = await fixture()
          h.decisions.set(h.toRid(fx.denied), 'deny')
          const hook = (label: string) => s.schedule(Promise.resolve(label)).then(() => undefined)
          b.gates.cte.hook = hook
          b.gates.read.hook = hook
          b.gates.mint.hook = hook
          const real: Real = {
            b,
            s,
            users,
            conns: [],
            moves: [],
            fixture: fx,
            failures: [],
            pParent: h.tree.root,
          }
          try {
            await fc.asyncModelRun(() => ({ model: {}, real }), cmds)
            b.gates.cte.mode = 'pass'
            await settleScheduler(real)
            await b.advance(7_000)
            await settleScheduler(real)
            b.clock.advance(300)
            await settleScheduler(real)
            const closed = real.conns.flatMap(c =>
              c.conn && c.conn.phase === 'closed' ? [c.conn] : []
            )
            const violations = [
              ...real.failures,
              ...b.violations(),
              ...restInvariantViolations(b, closed),
              ...checkModel(real),
              ...unhandled.map(e => `unhandled: ${String(e)}`),
            ]
            unhandled = []
            recordCoverage(real)
            expect(violations).toEqual([])
          } finally {
            b.gates.cte.hook = b.gates.read.hook = b.gates.mint.hook = null
            await b.stop()
          }
        }
      ),
      {
        // fast-check counts the examples inside numRuns; add them back so the
        // number of random runs is the one requested.
        numRuns: Number(process.env.GFS_WATCH_MODEL_RUNS ?? 25) + 1,
        endOnFailure: true,
        verbose: 1,
        // A fixed sequence that reaches every decision path, so the coverage
        // check below does not depend on what the random runs happen to draw:
        // an ancestor moves while the open is parked in front of its ancestry
        // query, a delta follows, and the listener is lost with a stream open.
        examples: [
          [
            fc.sample(fc.scheduler(), { seed: 1, numRuns: 1 })[0]!,
            [
              new OpenCmd(0, [1, 4]),
              new MoveCmd(true),
              new SettleCmd(),
              new PutCmd(0, [1, 3], 'next'),
              new SettleCmd(),
              new ListenerLostCmd(),
            ] as unknown as Iterable<fc.AsyncCommand<object, Real>>,
          ],
        ],
      }
    )
    // Every decision path must have been exercised, or a green run proves little.
    // The fixed example alone reaches all of them, so this guards the harness
    // and the example, not how widely the random runs happened to explore.
    expect(Object.entries(coverage).filter(([, n]) => n === 0)).toEqual([])
  }, 900_000)
})
