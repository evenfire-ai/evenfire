import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { ProcessMemoryRateLimiter } from '../src/middleware/processMemoryRateLimiter.js'
import type { GfsKey, Uuid } from '../src/services/gfsWatch/keys.js'
import type { WatchConnection } from '../src/services/gfsWatch/registry.js'
import { registryTestDatabase } from './helpers/gfsWatchRegistryEnv.js'
import type {
  BuiltRegistry,
  FakeSocket,
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
let createRegistryHarness!: Loaded['createRegistryHarness'],
  quoteIdent!: Loaded['quoteIdent'],
  restInvariantViolations!: Loaded['restInvariantViolations'],
  sleep!: Loaded['sleep']

// Scenario tests of the GFS watch registry on the real stack described in the
// harness. Every assertion is on frames the client sees or on the open's
// outcome; registry internals are read only by the rest invariants.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('GFS watch registry on real Postgres', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let b: BuiltRegistry
  let unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)

  beforeAll(async () => {
    ;({ createRegistryHarness, quoteIdent, restInvariantViolations, sleep } = await loadHelpers())
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(registryTestDatabase)}`)
    h = await createRegistryHarness(adminUrl!)
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

  afterEach(async () => {
    const violations = b?.violations() ?? []
    await b?.stop()
    h.decisions.clear()
    expect(violations).toEqual([])
    expect(unhandled).toEqual([])
    unhandled = []
  })

  async function ready(user: TestUser, keys: GfsKey[], build?: BuiltRegistry) {
    const reg = build ?? b
    const o = reg.open(user, keys)
    const outcome = await o.outcome
    expect(outcome).toEqual({ kind: 'stream' })
    return { socket: o.socket, conn: reg.connOf(o.socket)! }
  }

  let seqByConn = new Map<string, number>()
  async function put(
    conn: WatchConnection,
    keys: GfsKey[],
    seq?: number,
    binding?: { u: Uuid; g: number }
  ) {
    const s = seq ?? (seqByConn.get(conn.connId) ?? 0) + 1
    seqByConn.set(conn.connId, Math.max(s, seqByConn.get(conn.connId) ?? 0))
    await h.notifyCmd({
      c: conn.connId,
      s,
      u: binding?.u ?? conn.binding.userId,
      g: binding?.g ?? conn.binding.authGeneration,
      r: randomUUID() as Uuid,
      keys: new Set(keys),
    })
    return s
  }

  const until = (f: () => boolean) => b.settle(f)

  it('accepts granted keys of both kinds and reports the whole set in ready (T-SB104, T-SB92)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const dir = await h.tree.add('directory')
    const files = await Promise.all(Array.from({ length: 5 }, () => h.tree.add('file', dir)))
    const keys = [h.key('dir', dir), ...files.map(f => h.key('file', f))]
    const { socket } = await ready(user, keys)
    expect(new Set(socket.last('ready')!.accepted as string[])).toEqual(new Set(keys))
    expect(socket.status).toBe(200)
    expect(restInvariantViolations(b)).toEqual([])
  })

  it('accepts 64 keys with no key left without a chain', async () => {
    b = await h.build()
    const user = await h.createUser()
    const dir = await h.tree.add('directory')
    const files = await Promise.all(Array.from({ length: 63 }, () => h.tree.add('file', dir)))
    const keys = [h.key('dir', dir), ...files.map(f => h.key('file', f))]
    const { socket } = await ready(user, keys)
    expect((socket.last('ready')!.accepted as string[]).length).toBe(64)
    expect(socket.last('ready')!.deferred).toEqual([])
  })

  it('rejects a missing rid, a rid without access and a kind mismatch alike (T-SB24, T-SB36, I11)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const denied = await h.tree.add('file')
    const dir = await h.tree.add('directory')
    h.decisions.set(h.toRid(denied), 'deny')
    const missing = h.key('file', randomUUID())
    const keys = [missing, h.key('file', denied), h.key('file', dir)]
    const { socket } = await ready(user, keys)
    const r = socket.last('ready')!
    expect(new Set(r.rejected as string[])).toEqual(new Set(keys))
    expect(r.deferred).toEqual([])
    // Activity on a resource without access never reaches the client.
    await h.tree.rename(denied)
    await h.tree.softDelete(denied)
    await h.barrier()
    b.clock.advance(300)
    await b.settle()
    expect(socket.framesOf('changed')).toEqual([])
    expect(restInvariantViolations(b)).toEqual([])
  })

  it('defers a key gfsc answers with a transient error and still decides the rest (T-SB6)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const a = await h.tree.add('file')
    const c = await h.tree.add('file')
    h.decisions.set(h.toRid(a), 'unavailable')
    const { socket, conn } = await ready(user, [h.key('file', a), h.key('file', c)])
    expect(socket.last('ready')).toMatchObject({
      accepted: [h.key('file', c)],
      deferred: [h.key('file', a)],
    })
    expect(socket.last('ready')!.retryAfterMs).toBeGreaterThanOrEqual(1_000)
    h.decisions.set(h.toRid(a), 'unavailable')
    const d = await h.tree.add('file')
    await put(conn, [h.key('file', c), h.key('file', d), h.key('file', a)])
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({
      seq: 1,
      deferred: [h.key('file', a)],
    })
    expect(new Set(socket.last('subscriptions')!.accepted as string[])).toEqual(
      new Set([h.key('file', c), h.key('file', d)])
    )
  })

  it('delivers a rename of an accepted file and of a child to its directory, after the window (T-SB28)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const dir = await h.tree.add('directory')
    const f = await h.tree.add('file', dir)
    const { socket } = await ready(user, [h.key('file', f), h.key('dir', dir)])
    await h.tree.rename(f)
    await h.barrier()
    await b.settle()
    expect(socket.framesOf('changed')).toEqual([])
    b.clock.advance(250)
    await b.settle()
    expect(new Set(socket.last('changed')!.keys as string[])).toEqual(
      new Set([h.key('file', f), h.key('dir', dir)])
    )
  })

  it('defers a key whose ancestor moves while the open runs its ancestry query (T-SB8, T-SB18)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const p = await h.tree.add('directory')
    const q = await h.tree.add('directory')
    const f = await h.tree.add('file', p)
    b.gates.cte.mode = 'hold'
    const o = b.open(user, [h.key('file', f)])
    await until(() => b.gates.cte.held.length === 1)
    await h.tree.move(p, q)
    await h.barrier()
    b.gates.cte.mode = 'pass'
    b.gates.cte.releaseAll()
    expect(await o.outcome).toEqual({ kind: 'stream' })
    expect(o.socket.last('ready')).toMatchObject({ accepted: [], deferred: [h.key('file', f)] })
    expect(o.socket.last('ready')!.retryAfterMs).toBeGreaterThanOrEqual(6_000)
    // The retry once the dirty window passed decides it with the new chain.
    const conn = b.connOf(o.socket)!
    await b.advance(6_100)
    const s = await put(conn, [h.key('file', f)])
    await b.settle()
    expect(o.socket.last('subscriptions')).toMatchObject({ seq: s, accepted: [h.key('file', f)] })
    const chain = conn.keys.get(h.key('file', f))!.chain!
    expect(chain).toContain(h.toRid(q))
    // A retry of the same seq is dropped.
    const before = o.socket.framesOf('subscriptions').length
    await put(conn, [], s)
    await b.settle()
    expect(o.socket.framesOf('subscriptions').length).toBe(before)
  })

  it('defers a key through two moves during a delta, but not for moves in another subtree (T-SB15, T-SB20)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const p = await h.tree.add('directory')
    const q = await h.tree.add('directory')
    const other = await h.tree.add('directory')
    const f = await h.tree.add('file', p)
    const g = await h.tree.add('file', other)
    const unrelated = await Promise.all(Array.from({ length: 10 }, () => h.tree.add('file', other)))
    const { socket, conn } = await ready(user, [])
    await b.advance(6_100)
    b.gates.read.mode = 'hold'
    const s = await put(conn, [h.key('file', f), h.key('file', g)])
    await until(() => b.gates.read.held.length === 2)
    await h.tree.move(p, q)
    await h.tree.move(p, h.tree.root)
    for (const u of unrelated) await h.tree.softDelete(u)
    await h.barrier()
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({
      seq: s,
      accepted: [h.key('file', g)],
      deferred: [h.key('file', f)],
    })
  })

  it('never emits changed for a key of the delta in flight before its subscriptions (T-SB2)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [])
    b.gates.read.mode = 'hold'
    await put(conn, [h.key('file', f)])
    await until(() => b.gates.read.held.length === 1)
    await h.tree.rename(f)
    await h.barrier()
    b.clock.advance(300)
    await sleep(20)
    expect(socket.framesOf('changed')).toEqual([])
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await b.settle()
    b.clock.advance(300)
    await b.settle()
    const types = socket.frames.map(f2 => f2.type)
    expect(types.indexOf('subscriptions')).toBeGreaterThan(0)
    expect(types.slice(0, types.indexOf('subscriptions'))).not.toContain('changed')
  })

  it('holds back changed for a key accepted inside the delta still in flight (T-SB2)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const k1 = await h.tree.add('file')
    const k2 = await h.tree.add('file')
    const { socket, conn } = await ready(user, [])
    b.gates.read.mode = 'hold'
    await put(conn, [h.key('file', k1), h.key('file', k2)])
    await until(() => b.gates.read.held.length === 2)
    b.gates.read.releaseWhere(`read:${h.toRid(k1)}`)
    await until(() => conn.keys.get(h.key('file', k1))?.state === 'accepted')
    await h.tree.rename(k1)
    await h.barrier()
    b.clock.advance(300)
    await sleep(20)
    expect(socket.framesOf('changed')).toEqual([])
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({ seq: 1 })
    const types = socket.frames.map(f => f.type)
    expect(types.slice(0, types.indexOf('subscriptions'))).not.toContain('changed')
  })

  it('cancels a pending flush when the connection closes (I38)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [h.key('file', f)])
    await h.tree.rename(f)
    await h.barrier()
    await until(() => conn.timers.flush !== null)
    socket.emitGone()
    expect(restInvariantViolations(b, [conn])).toEqual([])
    b.clock.advance(300)
    expect(socket.framesOf('changed')).toEqual([])
  })

  it('answers 400 to an open over the key or drive ceilings, before admission', async () => {
    b = await h.build()
    const user = await h.createUser()
    const tooMany = Array.from({ length: 65 }, () => h.key('file', randomUUID()))
    const threeDrives = ['a', 'b', 'c'].map(
      d => `file:gfs://${d}/${h.toRid(randomUUID())}` as GfsKey
    )
    for (const keys of [tooMany, threeDrives]) {
      const o = b.open(user, keys)
      expect(await o.outcome).toEqual({ kind: 'reply', status: 400, code: 'bad_request' })
    }
    expect(b.registry.state.byConnId.size).toBe(0)
  })

  it('applies the newest of commands 3, 5, 4 with the delta of 3 in flight (T-SB3)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const [k3, k4, k5] = await Promise.all([
      h.tree.add('file'),
      h.tree.add('file'),
      h.tree.add('file'),
    ])
    const { socket, conn } = await ready(user, [])
    b.gates.read.mode = 'hold'
    await put(conn, [h.key('file', k3)], 3)
    await until(() => b.gates.read.held.length === 1)
    await put(conn, [h.key('file', k5)], 5)
    await put(conn, [h.key('file', k4)], 4)
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await b.settle()
    expect(socket.framesOf('subscriptions').map(f => f.seq)).toEqual([3, 5])
    expect(socket.last('subscriptions')!.accepted).toEqual([h.key('file', k5)])
    expect(conn.lastSeq).toBe(5)
  })

  it('drops a retry of the same seq while its delta is still in flight (T-SB18)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [])
    b.gates.read.mode = 'hold'
    await put(conn, [h.key('file', f)], 1)
    await until(() => b.gates.read.held.length === 1)
    await put(conn, [h.key('file', f)], 1)
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await b.settle()
    expect(socket.framesOf('subscriptions').map(x => x.seq)).toEqual([1])
    expect(h.reads.filter(r => r.rid32 === h.toRid(f))).toHaveLength(1)
  })

  it('drops commands for a closed connection, of another binding and that jump the seq window (T-SB4, T-SB5, T-SB68, I19)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const other = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [h.key('file', f)])
    // Another user's binding with a valid connId.
    await put(conn, [], 1, { u: other.userId, g: conn.binding.authGeneration })
    await put(conn, [], 1, { u: conn.binding.userId, g: conn.binding.authGeneration + 1 })
    // A forged seq far ahead.
    await put(conn, [], 2 ** 53 - 1)
    await b.settle()
    expect(socket.framesOf('subscriptions')).toEqual([])
    expect(conn.lastSeq).toBe(0)
    expect(conn.keys.get(h.key('file', f))?.state).toBe('accepted')
    // The legitimate next PUT still applies.
    await put(conn, [h.key('file', f)], 1)
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({ seq: 1, accepted: [h.key('file', f)] })
    // A forged command with the right binding and a key without access only gets `rejected`.
    const foreign = await h.tree.add('file')
    h.decisions.set(h.toRid(foreign), 'deny')
    await put(conn, [h.key('file', f), h.key('file', foreign)], 2)
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({
      seq: 2,
      rejected: [h.key('file', foreign)],
    })
    // Closed connection: nothing happens.
    socket.emitGone()
    await put(conn, [], 3)
    await b.settle()
    expect(socket.framesOf('subscriptions').length).toBe(2)
    expect(restInvariantViolations(b, [conn])).toEqual([])
  })

  it('applies a command built from another token of the same binding (T-SB112)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [])
    const second = await h.modules.registry.watchBindingOf(await user.authenticate())
    await put(conn, [h.key('file', f)], 1, { u: second!.userId, g: second!.authGeneration })
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({ seq: 1, accepted: [h.key('file', f)] })
  })

  it('round-trips keys byte for byte, including a constructor drive (T-SB106)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [])
    const odd = `dir:gfs://constructor/${h.toRid(randomUUID())}` as GfsKey
    await put(conn, [h.key('file', f), odd])
    await b.settle()
    const sub = socket.last('subscriptions')!
    expect([...(sub.accepted as string[]), ...(sub.rejected as string[])].sort()).toEqual(
      [h.key('file', f), odd].sort()
    )
  })

  it('defers every key and reads nothing when the ancestry query fails (T-SB26)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    b.gates.cte.mode = 'fail'
    b.gates.cte.failWith = () => new Error('Connection terminated unexpectedly')
    const readsBefore = h.reads.length
    const o = b.open(user, [h.key('file', f)])
    expect(await o.outcome).toEqual({ kind: 'stream' })
    expect(o.socket.last('ready')).toMatchObject({ accepted: [], deferred: [h.key('file', f)] })
    const conn = b.connOf(o.socket)!
    await put(conn, [h.key('file', f)])
    await b.settle()
    expect(o.socket.last('subscriptions')).toMatchObject({ deferred: [h.key('file', f)] })
    expect(h.reads.length).toBe(readsBefore)
    expect(restInvariantViolations(b)).toEqual([])
  })

  it('defers a key the ancestry query does not know even if gfsc answers 2xx (T-SB32)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const id = randomUUID()
    b.gates.read.mode = 'hold'
    const o = b.open(user, [h.key('file', id)])
    await until(() => b.gates.read.held.length === 1)
    // Created after the ancestry query ran: gfsc now finds it.
    await h.writer.query(
      `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind) VALUES ($1, 'main', $2, $3, 'file')`,
      [id, h.tree.root, `late-${id}`]
    )
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    expect(await o.outcome).toEqual({ kind: 'stream' })
    expect(o.socket.last('ready')).toMatchObject({ accepted: [], deferred: [h.key('file', id)] })
    expect(h.reads.at(-1)!.status).toBe(200)
  })

  it('closes with internal and answers watch_reopen when finishing the open throws (T-SB32)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const o = b.open(user, [])
    o.socket.writeHead = () => {
      throw new Error('injected')
    }
    expect(await o.outcome).toEqual({
      kind: 'reply',
      status: 503,
      code: 'watch_reopen',
      retryAfterSec: 2,
    })
    expect(b.registry.state.byConnId.size).toBe(0)
  })

  it('closes after the head when the ready write throws: 200 then EOF, connection gone (T-SB55)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const o = b.open(user, [])
    const write = o.socket.write.bind(o.socket)
    o.socket.write = (chunk: string) => {
      if (chunk.includes('"ready"')) throw new Error('injected')
      return write(chunk)
    }
    expect(await o.outcome).toEqual({ kind: 'none' })
    expect(o.socket.status).toBe(200)
    expect(o.socket.ended).toBe(1)
    expect(b.registry.state.byConnId.size).toBe(0)
  })

  it('defers keys still being read at T_auth and ends the op without waiting gfsc (T-SB16, T-SB19, T-SB78)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [])
    b.gates.read.mode = 'hold'
    await put(conn, [h.key('file', f)])
    await until(() => b.gates.read.held.length === 1)
    await b.advance(5_999)
    await sleep(10)
    expect(socket.framesOf('subscriptions')).toEqual([])
    b.clock.advance(1)
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({ deferred: [h.key('file', f)] })
    expect(conn.op).toBeNull()
    // A change on the deferred key afterwards emits nothing.
    await h.tree.rename(f)
    await h.barrier()
    b.clock.advance(300)
    await b.settle()
    expect(socket.framesOf('changed')).toEqual([])
    // The next PUT applies.
    b.gates.read.mode = 'pass'
    await put(conn, [h.key('file', f)])
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({ accepted: [h.key('file', f)] })
    expect(restInvariantViolations(b)).toEqual([])
  })

  it('emits ready at T_auth of the open with keys deferred, not a 503 (T-SB78, T-SB11)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    h.decisions.set(h.toRid(f), 'hang')
    const o = b.open(user, [h.key('file', f)])
    await until(() => h.reads.some(r => r.rid32 === h.toRid(f)))
    await b.advance(6_000)
    // Well before readGfsc's own 5 s timeout: the ready comes from T_auth.
    expect(await Promise.race([o.outcome, sleep(1_000).then(() => 'late')])).toEqual({
      kind: 'stream',
    })
    expect(o.socket.last('ready')).toMatchObject({ deferred: [h.key('file', f)] })
    h.releaseHanging()
  })

  it('ends the op at T_auth while the mint waits, and reads nothing after a close during the mint (T-SB107)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    b.gates.mint.mode = 'hold'
    const o = b.open(user, [h.key('file', f)])
    await until(() => b.gates.mint.held.length === 1)
    await b.advance(6_000)
    expect(await o.outcome).toEqual({ kind: 'stream' })
    expect(o.socket.last('ready')).toMatchObject({ deferred: [h.key('file', f)] })
    const conn = b.connOf(o.socket)!
    const readsBefore = h.reads.length
    await put(conn, [h.key('file', f)])
    await until(() => b.gates.mint.held.length === 2)
    const op = conn.op!
    o.socket.emitGone()
    b.gates.mint.mode = 'pass'
    b.gates.mint.releaseAll()
    await b.settle()
    await sleep(50)
    expect(h.reads.length).toBe(readsBefore)
    expect(op.tokens.size).toBe(0)
    expect(restInvariantViolations(b, [conn])).toEqual([])
  })

  it('spends no more budget and runs no ancestry query after a close during the budget check', async () => {
    let hits = 0
    let releaseFirst: () => void = () => {}
    const firstHeld = new Promise<void>(resolve => (releaseFirst = resolve))
    const budget = new ProcessMemoryRateLimiter(240)
    b = await h.build({
      authBudget: {
        hit: async k => {
          hits += 1
          if (hits === 1) await firstHeld
          return budget.hit(k)
        },
      },
    })
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const g = await h.tree.add('file')
    const { conn, socket } = await ready(user, [])
    const hitsBefore = hits
    const cteBefore = b.gates.cte.calls
    await put(conn, [h.key('file', f), h.key('file', g)])
    await until(() => hits === hitsBefore + 1)
    socket.emitGone()
    releaseFirst()
    await b.settle()
    await sleep(50)
    expect([hits - hitsBefore, b.gates.cte.calls - cteBefore]).toEqual([1, 0])
    expect(restInvariantViolations(b, [conn])).toEqual([])
  })

  it('mints nothing for the second drive after a close during the mint of the first', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const g = await h.tree.add('file')
    const { conn, socket } = await ready(user, [])
    b.gates.mint.mode = 'hold'
    await put(conn, [h.key('file', f), `file:gfs://other/${h.toRid(g)}` as GfsKey])
    await until(() => b.gates.mint.held.length === 1)
    const mintsBefore = b.gates.mint.calls
    socket.emitGone()
    await b.settle()
    await sleep(50)
    expect(b.gates.mint.calls).toBe(mintsBefore)
    b.gates.mint.mode = 'pass'
    b.gates.mint.releaseAll()
    await b.settle()
    expect(restInvariantViolations(b, [conn])).toEqual([])
  })

  it('closes with reauthorize before any read when the mint refuses a revoked session (T-SB108 a2)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [])
    const userSessions = await import('../src/services/auth/userSessionService.js')
    await userSessions.revokeLegacyUserSession(
      user.token,
      conn.authentication.tokenClaims as never,
      'gfs-watch-test'
    )
    const readsBefore = h.reads.length
    await put(conn, [h.key('file', f)])
    await b.settle()
    expect(socket.last('stream.closing')).toMatchObject({ reason: 'reauthorize' })
    expect(socket.framesOf('subscriptions')).toEqual([])
    expect(h.reads.length).toBe(readsBefore)
  })

  it('closes with reauthorize and no rejected key on a principal denial (T-SB99, I49)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const g = await h.tree.add('file')
    const { socket, conn } = await ready(user, [])
    h.decisions.set(h.toRid(f), 'principal_denied')
    await put(conn, [h.key('file', f), h.key('file', g)])
    await b.settle()
    expect(socket.last('stream.closing')).toMatchObject({ reason: 'reauthorize' })
    expect(socket.framesOf('subscriptions')).toEqual([])
    expect(restInvariantViolations(b, [conn])).toEqual([])
  })

  it('closes with internal when gfsc refuses the read token, without deferring (T-SB46)', async () => {
    b = await h.build({
      mintReadToken: async () => ({ token: 'fake-refused-read-token', expiresInSeconds: 60 }),
    })
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const o = b.open(user, [h.key('file', f)])
    expect(await o.outcome).toMatchObject({ kind: 'reply', status: 503, code: 'watch_reopen' })
    expect(h.reads.at(-1)!.status).toBe(401)
    expect(b.registry.state.byConnId.size).toBe(0)
  })

  it('cleans up a connection that leaves during the ancestry query (T-SB22)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    b.gates.cte.mode = 'hold'
    const o = b.open(user, [h.key('file', f)])
    await until(() => b.gates.cte.held.length === 1)
    const conn = b.connOf(o.socket)!
    o.socket.emitGone()
    // The ancestry query cannot be aborted: the open ends once it resolves.
    b.gates.cte.mode = 'pass'
    b.gates.cte.releaseAll()
    expect(await o.outcome).toEqual({ kind: 'none' })
    await b.settle()
    expect(o.socket.frames).toEqual([])
    expect(restInvariantViolations(b, [conn])).toEqual([])
  })

  it('ends the open one tick after the client leaves while the session check hangs (T-SB96)', async () => {
    b = await h.build()
    const user = await h.createUser()
    b.gates.observe.mode = 'hold'
    const o = b.open(user, [])
    await until(() => b.gates.observe.held.length === 1)
    o.socket.emitGone()
    await sleep(5)
    expect(o.settled()).toBe(true)
    expect(await o.outcome).toEqual({ kind: 'none' })
    b.gates.observe.mode = 'pass'
    b.gates.observe.releaseAll()
  })

  it('answers 401 when the session is revoked between authentication and admission (A4)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const authentication = await user.authenticate()
    const userSessions = await import('../src/services/auth/userSessionService.js')
    await userSessions.revokeLegacyUserSession(user.token, authentication.tokenClaims as never, 't')
    const { FakeSocket: Socket } = await import('./helpers/gfsWatchRegistryHarness.js')
    const socket = new Socket(() => true)
    const outcome = await b.registry.open({
      authentication,
      keys: new Set(),
      socket,
      srvDeadline: b.registry.now() + 12_000,
      watchSignal: new AbortController().signal,
      requestId: randomUUID(),
    })
    expect(outcome).toEqual({ kind: 'reply', status: 401, code: 'session_invalid' })
    expect(b.registry.state.byConnId.size).toBe(0)
  })

  it('answers watch_reauthorize to a retained user without spending budget, query or reads (T-SB76)', async () => {
    let hits = 0
    const budget = new ProcessMemoryRateLimiter(240)
    b = await h.build({
      authBudget: { hit: k => ((hits += 1), budget.hit(k)) },
    })
    const user = await h.createUser()
    const f = await h.tree.add('file')
    b.registry.hold(user.userId)
    const cteBefore = b.gates.cte.calls
    const readsBefore = h.reads.length
    const o = b.open(user, [h.key('file', f)])
    expect(await o.outcome).toEqual({
      kind: 'reply',
      status: 503,
      code: 'watch_reauthorize',
      retryAfterSec: 2,
    })
    expect([hits, b.gates.cte.calls - cteBefore, h.reads.length - readsBefore]).toEqual([0, 0, 0])
    b.registry.unhold(user.userId)
  })

  it('closes the open with watch_reauthorize when the user is retained while it runs (S5)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    b.gates.read.mode = 'hold'
    const o = b.open(user, [h.key('file', f)])
    await until(() => b.gates.read.held.length === 1)
    b.registry.hold(user.userId)
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    expect(await o.outcome).toMatchObject({ kind: 'reply', status: 503, code: 'watch_reauthorize' })
    expect(o.socket.frames).toEqual([])
    b.registry.unhold(user.userId)
  })

  it('drops the pending command of a retained delta and applies the next one (T-SB65)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const [k5, k6, k7] = await Promise.all([
      h.tree.add('file'),
      h.tree.add('file'),
      h.tree.add('file'),
    ])
    const { socket, conn } = await ready(user, [])
    b.gates.read.mode = 'hold'
    await put(conn, [h.key('file', k5)], 5)
    await until(() => b.gates.read.held.length === 1)
    await put(conn, [h.key('file', k6)], 6)
    b.registry.hold(user.userId)
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await b.settle()
    expect(socket.framesOf('subscriptions')).toEqual([])
    b.registry.unhold(user.userId)
    await put(conn, [h.key('file', k7)], 7)
    await b.settle()
    expect(conn.lastSeq).toBe(7)
    expect(socket.framesOf('subscriptions').map(f => f.seq)).toEqual([7])
    expect([...conn.keys.keys()]).toEqual([h.key('file', k7)])
  })

  it('holds back changed while the user is retained and sends it within 250 ms of the release (T-SB81, I44)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const { socket, conn } = await ready(user, [h.key('file', f)])
    b.registry.hold(user.userId)
    await h.tree.rename(f)
    await h.barrier()
    b.clock.advance(1_000)
    await b.settle()
    expect(socket.framesOf('changed')).toEqual([])
    expect(conn.timers.flush).not.toBeNull()
    b.registry.unhold(user.userId)
    b.clock.advance(250)
    await b.settle()
    expect(socket.last('changed')).toMatchObject({ keys: [h.key('file', f)] })
  })

  it('sends heartbeats, then closes at max_lifetime with stream.closing (I20, I38)', async () => {
    b = await h.build({ maxLifetimeMs: 60_000 })
    const user = await h.createUser()
    const { socket, conn } = await ready(user, [])
    await b.advance(41_000)
    expect(socket.framesOf('heartbeat').length).toBe(2)
    await b.advance(20_000)
    await b.settle()
    expect(socket.frames.at(-1)).toMatchObject({ type: 'stream.closing', reason: 'max_lifetime' })
    expect(socket.ended).toBe(1)
    expect(restInvariantViolations(b, [conn])).toEqual([])
  })

  it('closes at the token exp on the wall clock (T-SB45)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const exp = (await user.authenticate()).tokenClaims.exp as number
    b.clock.jumpWall(exp * 1000 - b.clock.wallNow() - 50)
    const { socket, conn } = await ready(user, [])
    b.clock.advance(50)
    await b.settle()
    expect(socket.frames.at(-1)).toMatchObject({
      type: 'stream.closing',
      reason: 'session_expired',
    })
    expect(restInvariantViolations(b, [conn])).toEqual([])
  })

  it('closes a consumer that does not read: over 64 KB, and after 5 s without drain (T-SB44, T-SB93)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const a = await ready(user, [])
    a.socket.writableLength = 64 * 1024 - 10
    await b.advance(20_000)
    await b.settle()
    expect(a.socket.framesOf('heartbeat')).toEqual([])
    expect(a.socket.framesOf('stream.closing')).toEqual([])
    expect(a.conn.closeReason).toBe('slow_consumer')
    expect(a.conn.timers.heartbeat).toBeNull()
    await b.advance(60_000)
    expect(restInvariantViolations(b, [a.conn])).toEqual([])

    const c = await ready(user, [])
    c.socket.writeReturns = false
    await b.advance(20_000)
    expect(c.conn.timers.drain).not.toBeNull()
    await b.advance(4_999)
    expect(c.conn.phase).toBe('ready')
    b.clock.advance(1)
    expect(c.conn.closeReason).toBe('slow_consumer')

    const d = await ready(user, [])
    d.socket.writeReturns = false
    await b.advance(20_000)
    d.socket.emitDrain()
    await b.advance(10_000)
    expect(d.conn.phase).toBe('ready')
    expect(d.conn.timers.drain).toBeNull()
  })

  it('closes only the connection whose heartbeat throws (T-SB50)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const a = await ready(user, [])
    const c = await ready(user, [])
    a.socket.write = () => {
      throw new Error('injected')
    }
    await b.advance(20_000)
    expect(a.conn.closeReason).toBe('internal')
    expect(c.conn.phase).toBe('ready')
    expect(c.socket.framesOf('heartbeat').length).toBe(1)
  })

  it('closes on a response error as client_gone, and the others stay (T-SB72)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const a = await ready(user, [])
    const c = await ready(user, [])
    a.socket.emitGone()
    expect(a.conn.closeReason).toBe('client_gone')
    expect(a.socket.framesOf('stream.closing')).toEqual([])
    expect(c.conn.phase).toBe('ready')
  })

  it('stopRegistry: stream.closing to ready, 503 to opening, nothing left (T-SB43)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const r = await ready(user, [])
    b.gates.read.mode = 'hold'
    const o = b.open(user, [h.key('file', f)])
    await until(() => b.gates.read.held.length === 1)
    b.registry.stop()
    expect(r.socket.frames.at(-1)).toMatchObject({
      type: 'stream.closing',
      reason: 'server_shutdown',
    })
    expect(r.socket.ended).toBe(1)
    expect(await o.outcome).toMatchObject({ kind: 'reply', status: 503, code: 'watch_reopen' })
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await b.settle()
    expect(b.registry.state.byConnId.size).toBe(0)
    expect(b.registry.state.opsInFlight.size).toBe(0)
    expect(b.registry.listenerReady()).toBe(false)
    const late = b.open(user, [])
    expect(await late.outcome).toMatchObject({ status: 503, code: 'watch_listener_unavailable' })
  })

  it('on listener loss closes every stream with a spread retry, the opening ones with matching Retry-After (T-SB7, T-SB54, T-SB70, I17)', async () => {
    b = await h.build({})
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const readyOnes = [await ready(user, []), await ready(user, [])]
    b.gates.read.mode = 'hold'
    const opening = b.open(user, [h.key('file', f)])
    await until(() => b.gates.read.held.length === 1)
    const openingConn = b.connOf(opening.socket)!
    expect(await h.terminateListener()).toBe(1)
    await until(() => !b.registry.listenerReady())
    // 3 connections: spread 120 ms; the clock's random is 0.5.
    for (const r of readyOnes) {
      expect(r.socket.frames.at(-1)).toMatchObject({
        type: 'stream.closing',
        reason: 'listener_lost',
        retryAfterMs: 60,
      })
    }
    expect(openingConn.closeRetryAfterMs).toBe(60)
    expect(await opening.outcome).toEqual({
      kind: 'reply',
      status: 503,
      code: 'watch_reopen',
      retryAfterSec: 1,
    })
    const down = b.open(user, [])
    expect(await down.outcome).toMatchObject({ status: 503, code: 'watch_listener_unavailable' })
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    // Reconnects after the backoff and opens again.
    b.clock.advance(1_200)
    await until(() => b.registry.listenerReady())
    await ready(user, [h.key('file', f)])
  })

  it('reports retryAfterMs from the authorization budget reset and from a suspect key (T-SB73)', async () => {
    const budget = new ProcessMemoryRateLimiter(1)
    b = await h.build({ authBudget: budget })
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const g = await h.tree.add('file')
    const o = b.open(user, [h.key('file', f), h.key('file', g)])
    expect(await o.outcome).toEqual({ kind: 'stream' })
    const r = o.socket.last('ready')!
    expect(r.deferred).toHaveLength(1)
    // resetMs is a wall-clock instant ≈ 60 s ahead of Date.now(); the virtual wall clock is earlier.
    expect(r.retryAfterMs).toBeGreaterThan(30_000)
  })

  it('defers a key added right after a move of its ancestor, from the recent-dirty window (T-SB35)', async () => {
    b = await h.build()
    const user = await h.createUser()
    const p = await h.tree.add('directory')
    const q = await h.tree.add('directory')
    const f = await h.tree.add('file', p)
    const { socket, conn } = await ready(user, [])
    await h.tree.move(p, q)
    await h.barrier()
    await b.advance(100)
    await put(conn, [h.key('file', f)])
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({ deferred: [h.key('file', f)] })
    await b.advance(6_000)
    await put(conn, [h.key('file', f)])
    await b.settle()
    expect(socket.last('subscriptions')).toMatchObject({ accepted: [h.key('file', f)] })
  })

  it('bounds T_auth one second before a short server deadline', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    b.gates.read.mode = 'hold'
    const o = b.open(user, [h.key('file', f)], { srvDeadlineMs: 3_000 })
    await until(() => b.gates.read.held.length === 1)
    b.clock.advance(1_999)
    await sleep(10)
    expect(o.settled()).toBe(false)
    b.clock.advance(1)
    expect(await o.outcome).toEqual({ kind: 'stream' })
    expect(o.socket.last('ready')).toMatchObject({ deferred: [h.key('file', f)] })
  })

  it('admits at most 8 streams per user and answers 429 with Retry-After 5 after that', async () => {
    b = await h.build()
    const user = await h.createUser()
    const opened = []
    for (let i = 0; i < 8; i += 1) opened.push(await ready(user, []))
    const ninth = b.open(user, [])
    expect(await ninth.outcome).toEqual({
      kind: 'reply',
      status: 429,
      code: 'admission_full',
      retryAfterSec: 5,
    })
    opened[0]!.socket.emitGone()
    await ready(user, [])
  })

  it('admits against injected process and per-user caps with the same 429', async () => {
    b = await h.build({ maxConnections: 2, maxConnectionsPerPrincipal: 1 })
    const full = { kind: 'reply', status: 429, code: 'admission_full', retryAfterSec: 5 }
    const alice = await h.createUser()
    const bob = await h.createUser()
    const carol = await h.createUser()
    const first = await ready(alice, [])
    expect(await b.open(alice, []).outcome).toEqual(full)
    await ready(bob, [])
    expect(await b.open(carol, []).outcome).toEqual(full)
    first.socket.emitGone()
    await ready(carol, [])
  })

  it('caps reads in flight per process and leaves no permit or waiter behind (T-SB83, I42)', async () => {
    const { createReadSlots } = await import('../src/services/gfsWatch/readSlots.js')
    const clockless = { now: () => 0 }
    const slots = createReadSlots(clockless.now, 3)
    b = await h.build({ readSlots: slots })
    const user = await h.createUser()
    const ids = await Promise.all(Array.from({ length: 6 }, () => h.tree.add('file')))
    b.gates.read.mode = 'hold'
    const o1 = b.open(
      user,
      ids.slice(0, 3).map(id => h.key('file', id))
    )
    const o2 = b.open(
      user,
      ids.slice(3).map(id => h.key('file', id))
    )
    await until(() => b.gates.read.held.length === 3 && slots.waiters > 0)
    expect(slots.free).toBe(0)
    await b.advance(6_000)
    expect(await o1.outcome).toEqual({ kind: 'stream' })
    expect(await o2.outcome).toEqual({ kind: 'stream' })
    expect([
      ...(o1.socket.last('ready')!.deferred as string[]),
      ...(o2.socket.last('ready')!.deferred as string[]),
    ]).toHaveLength(6)
    b.gates.read.mode = 'pass'
    await b.settle()
    expect([slots.free, slots.waiters, slots.demand]).toEqual([3, 0, 0])
  })
})

describe('GFS watch registry construction', () => {
  it('refuses to build with a cap that is not a positive integer', async () => {
    const { createGfsWatchRegistry } = await import('../src/services/gfsWatch/registry.js')
    for (const bad of [{ maxConnections: Number.NaN }, { maxConnectionsPerPrincipal: 0 }]) {
      expect(() =>
        createGfsWatchRegistry({
          listenConnectionString: 'postgres://unused',
          watchPool: {} as never,
          ...bad,
        })
      ).toThrow(/must be a positive integer/)
    }
  })
})
