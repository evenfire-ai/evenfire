import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { GfsKey } from '../src/services/gfsWatch/keys.js'
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
let createRegistryHarness!: Loaded['createRegistryHarness'],
  quoteIdent!: Loaded['quoteIdent'],
  restInvariantViolations!: Loaded['restInvariantViolations']

// Scenario tests of the roots window and the session hint of the GFS watch
// registry. Every NOTIFY comes from a committed write through the real
// gfs_resource_changed, gfs_authz_changed and users triggers: grants and
// shares through the routes' batch writers, retirement, password change and
// revoke-all through their production services. A payload is forged only
// where the case is a false or unreadable hint. Assertions are on the frames
// the client sees and on the registry at rest (holds, pending reasons and
// window handles).

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('GFS watch roots window and session hints on real Postgres', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let b: BuiltRegistry
  let unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)

  beforeAll(async () => {
    ;({ createRegistryHarness, quoteIdent, restInvariantViolations } = await loadHelpers())
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
    // After stop and the confirmations it releases: their writes are checked
    // like any other frame.
    await b?.stop()
    await b?.settle(() => (b?.registry.state.windows().sessionConfirming.length ?? 0) === 0)
    const violations = b?.violations() ?? []
    const w = b?.registry.state.windows()
    h.decisions.clear()
    expect(violations).toEqual([])
    // stopRegistry leaves no window, pending reason or hold behind.
    expect(w?.rootsWindow ?? null).toBeNull()
    expect(w?.sessionWindow ?? null).toBeNull()
    expect(w?.failClosedTimer ?? null).toBeNull()
    expect([...(w?.sessionPending ?? [])]).toEqual([])
    expect([...(w?.rootsRids ?? [])]).toEqual([])
    expect([...(w?.failClosedPending ?? [])]).toEqual([])
    expect([...(b?.registry.state.holdUsers.keys() ?? [])]).toEqual([])
    expect(unhandled).toEqual([])
    unhandled = []
  })

  async function ready(user: TestUser, keys: GfsKey[]) {
    const o = b.open(user, keys)
    const outcome = await o.outcome
    expect(outcome).toEqual({ kind: 'stream' })
    return o.socket
  }

  const until = (f: () => boolean, ms = 8_000) => b.settle(f, ms)
  const closings = (s: FakeSocket) => s.framesOf('stream.closing').map(f => f.reason)
  const roots = (s: FakeSocket) => s.framesOf('roots_changed').length
  const held = () => [...b.registry.state.holdUsers.keys()]

  /** Fires a 250 ms window and waits for every window query to settle. */
  async function fire() {
    await b.advance(300)
    await b.settle()
  }

  /** Fires the roots window while a session confirmation is held on purpose. */
  async function fireRoots() {
    await b.advance(300)
    await b.settle(
      () =>
        b.gates.roots.calls === b.gates.roots.done &&
        b.registry.state.windows().rootsWindow === null
    )
  }

  async function forge(channel: string, payload: string) {
    await h.writer.query('SELECT pg_notify($1, $2)', [channel, payload])
    await h.barrier()
  }

  async function generation(user: TestUser): Promise<number> {
    return (await h.lifecycle.version(user.userId))!.version
  }

  /** Times (virtual clock) at which each roots_changed reached the socket. */
  function rootsTimes(s: FakeSocket): number[] {
    const times: number[] = []
    s.onFrame = f => {
      if (f.type === 'roots_changed') times.push(b.clock.now())
    }
    return times
  }

  /** A file key gfsc lets the user read; the grant only matters to the roots query. */
  async function fileKey(): Promise<GfsKey> {
    return h.key('file', await h.tree.add('file'))
  }

  /** Terminal for the client: the stream closed and its session no longer authenticates. */
  async function expectTerminal(s: FakeSocket, user: TestUser) {
    await until(() => s.ended > 0)
    expect(closings(s)).toHaveLength(1)
    expect(['session_expired', 'reauthorize']).toContain(closings(s)[0])
    await expect(user.authenticate()).rejects.toThrow(/did not authenticate/)
  }

  // ─── Roots window ────────────────────────────────────────────────────────

  it('T-S15 / T-SB97 / T-S27: a renamed root reaches its direct and team grantees with read, through grants and shares of every subject type, and no one else', async () => {
    b = await h.build()
    const [direct, shared, member, inactive, writeOnly, stranger] = [
      await h.createUser(),
      await h.createUser(),
      await h.createUser(),
      await h.createUser(),
      await h.createUser(),
      await h.createUser(),
    ]
    const team = await h.authz.createTeam()
    await h.authz.join(team, member.userId)
    await h.authz.join(team, inactive.userId)
    await h.authz.leave(team, inactive.userId)
    const d = await h.tree.add('directory')
    await h.authz.grant(d, 'user', direct.userId)
    await h.authz.share(d, 'user', shared.userId)
    await h.authz.grant(d, 'team', team)
    await h.authz.grant(d, 'user', writeOnly.userId, ['write'])
    // subject_id that is no uuid, and the operator's empty one: the query compares them as text.
    await h.authz.grant(d, 'host', 'host-roots-test')
    await h.authz.share(d, 'team', team)
    await h.authz.grant(d, 'operator', '')
    await h.barrier()
    const s = {
      direct: await ready(direct, [await fileKey()]),
      shared: await ready(shared, [await fileKey()]),
      member: await ready(member, [await fileKey()]),
      inactive: await ready(inactive, [await fileKey()]),
      writeOnly: await ready(writeOnly, [await fileKey()]),
      stranger: await ready(stranger, [await fileKey()]),
    }
    await fire()
    const queries = b.gates.roots.calls

    await h.tree.rename(d)
    await h.barrier()
    await fire()
    expect(b.gates.roots.calls).toBe(queries + 1)
    expect(roots(s.direct)).toBe(1)
    expect(roots(s.shared)).toBe(1)
    expect(roots(s.member)).toBe(1)
    expect(roots(s.inactive)).toBe(0)
    expect(roots(s.writeOnly)).toBe(0)
    expect(roots(s.stranger)).toBe(0)
    for (const socket of Object.values(s)) {
      expect(closings(socket)).toEqual([])
      for (const f of socket.framesOf('roots_changed')) {
        expect(Object.keys(f).sort()).toEqual(['schemaVersion', 'type'])
      }
    }
    expect(restInvariantViolations(b)).toEqual([])
  })

  it('one roots window accumulates every rid of a burst: one grantee query, every grantee told once', async () => {
    b = await h.build()
    const [u1, u2] = [await h.createUser(), await h.createUser()]
    const d1 = await h.tree.add('directory')
    const d2 = await h.tree.add('directory')
    await h.authz.grant(d1, 'user', u1.userId)
    await h.authz.grant(d2, 'user', u2.userId)
    await h.barrier()
    const s1 = await ready(u1, [await fileKey()])
    const s2 = await ready(u2, [await fileKey()])
    await fire()
    const queries = b.gates.roots.calls
    const timers = b.clock.pendingCount()
    for (const d of [d1, d2, d1, d2]) await h.tree.rename(d)
    await h.barrier()
    // One window for the whole burst: one timer more, whatever the number of hints.
    expect(b.clock.pendingCount()).toBe(timers + 1)
    await fire()
    expect(b.gates.roots.calls).toBe(queries + 1)
    expect(roots(s1)).toBe(1)
    expect(roots(s2)).toBe(1)
  })

  it('T-S24 / T-SB94: 200 inserts in 2 s give each linked operator at most one roots_changed per 2 s, the user none, and no grantee query', async () => {
    const flag = h.modules.config.config.desktopGfsOperatorLinkingEnabled
    h.modules.config.config.desktopGfsOperatorLinkingEnabled = true
    try {
      await linkedOperatorsCase()
    } finally {
      h.modules.config.config.desktopGfsOperatorLinkingEnabled = flag
    }
  })

  async function linkedOperatorsCase() {
    b = await h.build()
    const [op1, op2, user] = [await h.createUser(), await h.createUser(), await h.createUser()]
    await h.authz.link(op1.userId, await h.authz.createAdmin())
    await h.authz.link(op2.userId, await h.authz.createAdmin())
    const d = await h.tree.add('directory')
    await h.authz.grant(d, 'user', user.userId)
    await h.barrier()
    const s1 = await ready(op1, [])
    const s2 = await ready(op2, [])
    const su = await ready(user, [await fileKey()])
    expect([...b.registry.state.byConnId.values()].map(c => c.principalKind).sort()).toEqual([
      'linked_operator',
      'linked_operator',
      'user',
    ])
    const t1 = rootsTimes(s1)
    const t2 = rootsTimes(s2)
    const start = b.clock.now()
    const queries = b.gates.roots.calls

    for (let batch = 0; batch < 10; batch += 1) {
      await h.writer.query(
        `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind)
         SELECT gen_random_uuid(), 'main', $1, 'bulk-' || gen_random_uuid(), 'file'
           FROM generate_series(1, 20)`,
        [d]
      )
      await h.barrier()
      await b.advance(200)
      await b.settle()
    }
    for (const times of [t1, t2]) {
      expect(times.filter(t => t < start + 2_000).length).toBeGreaterThanOrEqual(1)
      expect(times.filter(t => t < start + 2_000).length).toBeLessThanOrEqual(2)
    }
    await b.advance(4_500)
    await b.settle()
    for (const times of [t1, t2]) {
      // The trailing notice: the last insert is never left unannounced.
      expect(times.at(-1)!).toBeGreaterThanOrEqual(start + 2_000)
      for (let i = 1; i < times.length; i += 1) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(2_000)
      }
    }
    expect(roots(su)).toBe(0)
    expect(b.gates.roots.calls).toBe(queries)
    expect(closings(s1)).toEqual([])
    expect(closings(s2)).toEqual([])
  }

  it('T-SB98: a roots_changed dropped while retained does not delay the first one after the release', async () => {
    b = await h.build()
    const user = await h.createUser()
    const d = await h.tree.add('directory')
    await h.authz.grant(d, 'user', user.userId)
    await h.barrier()
    const socket = await ready(user, [await fileKey()])
    await fire()

    b.gates.session.mode = 'hold'
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    await b.advance(300)
    await until(() => b.gates.session.held.length === 1)
    await h.tree.rename(d)
    await h.barrier()
    await fireRoots()
    // Retained: the notice is dropped by the writer.
    expect(roots(socket)).toBe(0)

    b.gates.session.mode = 'pass'
    b.gates.session.releaseAll()
    await until(() => held().length === 0)
    expect(closings(socket)).toEqual([])
    await h.tree.rename(d)
    await h.barrier()
    await fire()
    expect(roots(socket)).toBe(1)
  })

  it('T-SB69: a trailing roots_changed that comes due while the user is retained is not written; the next one after the release is', async () => {
    b = await h.build()
    const user = await h.createUser()
    const d = await h.tree.add('directory')
    await h.authz.grant(d, 'user', user.userId)
    await h.barrier()
    const socket = await ready(user, [await fileKey()])
    await fire()
    await h.tree.rename(d)
    await h.barrier()
    await fire()
    expect(roots(socket)).toBe(1)

    b.gates.session.mode = 'hold'
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    await b.advance(300)
    await until(() => b.gates.session.held.length === 1)
    await h.tree.rename(d)
    await h.barrier()
    await fireRoots()
    expect(b.connOf(socket)!.timers.rootsTrailing).not.toBeNull()
    await b.advance(2_000)
    await b.settle(() => b.connOf(socket)!.timers.rootsTrailing === null)
    expect(roots(socket)).toBe(1)

    b.gates.session.mode = 'pass'
    b.gates.session.releaseAll()
    await until(() => held().length === 0)
    await h.tree.rename(d)
    await h.barrier()
    await fire()
    expect(roots(socket)).toBe(2)
    expect(closings(socket)).toEqual([])
  })

  it('E11 with a grantee query in flight: no roots_changed reaches a stream opened after the reconnect', async () => {
    b = await h.build()
    const user = await h.createUser()
    const d = await h.tree.add('directory')
    await h.authz.grant(d, 'user', user.userId)
    await h.barrier()
    const first = await ready(user, [await fileKey()])
    await fire()
    b.gates.roots.mode = 'hold'
    await h.tree.rename(d)
    await h.barrier()
    await b.advance(300)
    await until(() => b.gates.roots.held.length === 1)
    expect(await h.terminateListener()).toBe(1)
    await until(() => !b.registry.listenerReady())
    await b.advance(1_200)
    await until(() => b.registry.listenerReady())
    const second = await ready(user, [await fileKey()])
    b.gates.roots.mode = 'pass'
    b.gates.roots.releaseAll()
    await b.settle()
    expect(roots(first)).toBe(0)
    expect(roots(second)).toBe(0)
  })

  // Cancelling the armed window itself is hardening: E11 also empties rootsRids
  // and rootsPending, so a window that still fired would query nothing and
  // tell no one. What this test pins is that the pending rid is dropped.
  it('E11 with the roots window armed: the pending rid does not reach the streams opened after the reconnect', async () => {
    b = await h.build()
    const user = await h.createUser()
    const d = await h.tree.add('directory')
    const unrelated = await h.tree.add('directory')
    await h.authz.grant(d, 'user', user.userId)
    await h.barrier()
    await ready(user, [await fileKey()])
    await fire()
    await h.tree.rename(d)
    await h.barrier()
    expect(b.registry.state.windows().rootsWindow).not.toBeNull()
    const queries = b.gates.roots.calls
    // Held, so a window that outlived the loss would resolve after the reopen.
    b.gates.roots.mode = 'hold'
    expect(await h.terminateListener()).toBe(1)
    await until(() => !b.registry.listenerReady())
    await b.advance(1_200)
    await until(() => b.registry.listenerReady())
    const second = await ready(user, [await fileKey()])
    b.gates.roots.mode = 'pass'
    b.gates.roots.releaseAll()
    await fire()
    // The rid pending before the loss is never queried.
    expect(b.gates.roots.calls).toBe(queries)
    expect(roots(second)).toBe(0)
    // A change the user does not list must not carry the rid the loss dropped.
    await h.tree.rename(unrelated)
    await h.barrier()
    await fire()
    expect(roots(second)).toBe(0)
  })

  // ─── Session hints ───────────────────────────────────────────────────────

  it('T-S13 / T-SB110: revoke-all closes with session_expired within one window and the reopen is refused', async () => {
    b = await h.build()
    const user = await h.createUser()
    const socket = await ready(user, [await fileKey()])
    await h.lifecycle.revokeAll(user.userId)
    await h.barrier()
    // Held from the NOTIFY on, before the row is read.
    expect(held()).toEqual([user.userId])
    await fire()
    expect(closings(socket)).toEqual(['session_expired'])
    await expectTerminal(socket, user)
    expect(held()).toEqual([])
  })

  for (const writer of ['password change', 'revoke-all'] as const) {
    it(`T-SB110: a ${writer} with a delta in flight ends the stream and the reopen is refused`, async () => {
      b = await h.build()
      const user = await h.createUser()
      const k1 = await fileKey()
      const k2 = await fileKey()
      const socket = await ready(user, [k1])
      const conn = b.connOf(socket)!
      b.gates.read.mode = 'hold'
      await h.notifyCmd({
        c: conn.connId,
        s: 1,
        u: user.userId,
        g: conn.binding.authGeneration,
        r: crypto.randomUUID() as never,
        keys: new Set([k1, k2]),
      })
      await until(() => b.gates.read.held.length === 1)

      if (writer === 'password change') await h.lifecycle.changePassword(user.userId)
      else await h.lifecycle.revokeAll(user.userId)
      await h.barrier()
      await fire()
      b.gates.read.mode = 'pass'
      b.gates.read.releaseAll()
      await b.settle()
      expect(socket.framesOf('subscriptions')).toEqual([])
      await expectTerminal(socket, user)
    })
  }

  it('T-S25: a revoke-all that lands while the open is between authentication and its decision never leaves the stream open', async () => {
    b = await h.build()
    const user = await h.createUser()
    b.gates.read.mode = 'hold'
    const o = b.open(user, [await fileKey()])
    await until(() => b.gates.read.held.length === 1)
    await h.lifecycle.revokeAll(user.userId)
    await h.barrier()
    await fire()
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    const outcome = await o.outcome
    await b.settle()
    expect(outcome.kind).not.toBe('stream')
    expect(o.socket.framesOf('ready')).toEqual([])
    expect(b.registry.state.byConnId.size).toBe(0)
  })

  it('T-SB51: a forged retired hint with the row active closes nothing and releases the hold', async () => {
    b = await h.build()
    const user = await h.createUser()
    const other = await h.createUser()
    const socket = await ready(user, [await fileKey()])
    const otherSocket = await ready(other, [await fileKey()])
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    expect(held()).toEqual([user.userId])
    await fire()
    expect(b.gates.session.calls).toBe(1)
    expect(closings(socket)).toEqual([])
    expect(closings(otherSocket)).toEqual([])
    expect(held()).toEqual([])
    expect(b.registry.state.windows().sessionPending.size).toBe(0)
  })

  it('T-SB51: a retirement through the real writer, with membership and operator links, ends the stream', async () => {
    b = await h.build()
    const user = await h.createUser()
    const admin = await h.authz.createAdmin()
    await h.authz.link(user.userId, admin)
    await h.barrier()
    const socket = await ready(user, [])
    const r = await h.lifecycle.retire(user.userId)
    expect(r.outcome).toBe('retired')
    await h.barrier()
    await fire()
    await b.advance(600)
    await b.settle()
    await expectTerminal(socket, user)
    expect(held()).toEqual([])
  })

  it('T-SB51: with the confirmation query failing a forged hint reopens with reauthorize, never session_expired', async () => {
    b = await h.build()
    const user = await h.createUser()
    const socket = await ready(user, [await fileKey()])
    b.gates.session.mode = 'fail'
    b.gates.session.failWith = () => new Error('Connection terminated unexpectedly')
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    await fire()
    expect(closings(socket)).toEqual(['reauthorize'])
    await expect(user.authenticate()).resolves.toBeDefined()
    expect(held()).toEqual([])
  })

  it('one session window accumulates every hint: one confirmation, one hold per user', async () => {
    b = await h.build()
    const [u1, u2] = [await h.createUser(), await h.createUser()]
    const s1 = await ready(u1, [await fileKey()])
    const s2 = await ready(u2, [await fileKey()])
    const timers = b.clock.pendingCount()
    for (const u of [u1, u2, u1, u2, u1]) {
      await forge('gfs_watch_session', `${u.userId}:retired:1`)
    }
    expect(b.clock.pendingCount()).toBe(timers + 1)
    expect(b.registry.state.holdUsers.get(u1.userId)).toBe(1)
    expect(b.registry.state.holdUsers.get(u2.userId)).toBe(1)
    await fire()
    expect(b.gates.session.calls).toBe(1)
    expect(held()).toEqual([])
    expect(closings(s1)).toEqual([])
    expect(closings(s2)).toEqual([])
  })

  it('T-SB51: a lower or equal version is not an affected hint unless the state changed', async () => {
    b = await h.build()
    const user = await h.createUser()
    const g = await generation(user)
    const socket = await ready(user, [await fileKey()])
    await forge('gfs_watch_session', `${user.userId}:active:${g - 1}`)
    await forge('gfs_watch_session', `${user.userId}:active:${g}`)
    expect(held()).toEqual([])
    await fire()
    expect(b.gates.session.calls).toBe(0)

    await forge('gfs_watch_session', `${user.userId}:retired:${g - 1}`)
    expect(held()).toEqual([user.userId])
    await fire()
    expect(b.gates.session.calls).toBe(1)
    expect(closings(socket)).toEqual([])

    // A higher version is affected; the row, at g, says the session stands.
    await forge('gfs_watch_session', `${user.userId}:active:${g + 1}`)
    expect(held()).toEqual([user.userId])
    await fire()
    expect(b.gates.session.calls).toBe(2)
    expect(closings(socket)).toEqual([])
    expect(held()).toEqual([])
  })

  it('T-SB48 / T-SB90: deleting a user without team or links emits deleted, the confirmation finds no row and closes with session_expired', async () => {
    b = await h.build()
    const user = await h.createUser()
    // No membership left: its cascade would otherwise reauthorize first.
    await h.writer.query(`DELETE FROM team_members WHERE user_id = $1`, [user.userId])
    await h.barrier()
    const socket = await ready(user, [])
    const r = await h.lifecycle.retire(user.userId)
    expect(r.outcome).toBe('deleted')
    await h.barrier()
    expect(held()).toEqual([user.userId])
    await fire()
    // One close in the plan, 40 ms, and the virtual clock's random() of 0.5.
    expect(socket.framesOf('stream.closing')).toEqual([
      { schemaVersion: 1, type: 'stream.closing', reason: 'session_expired', retryAfterMs: 20 },
    ])
    expect(held()).toEqual([])
  })

  it('T-SB90: an invalid session payload fails closed: every user held at once, every stream reauthorized at rest', async () => {
    b = await h.build()
    const [u1, u2] = [await h.createUser(), await h.createUser()]
    const s1 = await ready(u1, [await fileKey()])
    const s2 = await ready(u2, [await fileKey()])
    await forge('gfs_watch_session', `${u1.userId}:purged:1`)
    expect(new Set(held())).toEqual(new Set([u1.userId, u2.userId]))
    await fire()
    expect(closings(s1)).toEqual(['reauthorize'])
    expect(closings(s2)).toEqual(['reauthorize'])
    expect(held()).toEqual([])
  })

  it('T-SB58: a second hint during the first confirmation keeps the user retained until the second resolves; so does an overlapping fail-closed', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const k = h.key('file', f)
    const socket = await ready(user, [k])
    const conn = b.connOf(socket)!

    b.gates.session.mode = 'hold'
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    await b.advance(300)
    await until(() => b.gates.session.held.length === 1)
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    expect(b.registry.state.holdUsers.get(user.userId)).toBe(2)

    b.gates.session.releaseOne()
    await until(() => b.gates.session.done === 1)
    expect(b.registry.state.holdUsers.get(user.userId)).toBe(1)
    // A change and a decision while still retained: neither goes out.
    await h.tree.rename(f)
    await h.barrier()
    await h.notifyCmd({
      c: conn.connId,
      s: 1,
      u: user.userId,
      g: conn.binding.authGeneration,
      r: crypto.randomUUID() as never,
      keys: new Set([k]),
    })
    await b.advance(300)
    await until(() => b.gates.session.held.length === 1)
    expect(socket.framesOf('changed')).toEqual([])
    expect(socket.framesOf('subscriptions')).toEqual([])

    // The fail-closed overlaps the second confirmation.
    await forge('gfs_authz_changed', 'x:garbage')
    expect(b.registry.state.holdUsers.get(user.userId)).toBe(2)
    b.gates.session.mode = 'pass'
    b.gates.session.releaseAll()
    await until(() => b.gates.session.done === 2)
    expect(b.registry.state.holdUsers.get(user.userId)).toBe(1)
    expect(socket.framesOf('changed')).toEqual([])
    await fire()
    expect(closings(socket)).toEqual(['reauthorize'])
    expect(held()).toEqual([])
  })

  it('T-SB58: the change held back by a false hint goes out once the hint is resolved', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const socket = await ready(user, [h.key('file', f)])
    b.gates.session.mode = 'hold'
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    await h.tree.rename(f)
    await h.barrier()
    await b.advance(300)
    await until(() => b.gates.session.held.length === 1)
    await b.advance(600)
    expect(socket.framesOf('changed')).toEqual([])
    b.gates.session.mode = 'pass'
    b.gates.session.releaseAll()
    await until(() => held().length === 0)
    await fire()
    expect(socket.framesOf('changed')).toEqual([
      { schemaVersion: 1, type: 'changed', keys: [h.key('file', f)] },
    ])
  })

  it('a confirmation spreads the reopens over every close of its plan, across users', async () => {
    b = await h.build()
    const [u1, u2] = [await h.createUser(), await h.createUser()]
    const s1 = await ready(u1, [await fileKey()])
    const s2 = await ready(u2, [await fileKey()])
    await h.lifecycle.revokeAll(u1.userId)
    await h.lifecycle.revokeAll(u2.userId)
    await h.barrier()
    await fire()
    // Two closes, 40 ms each, and the virtual clock's random() of 0.5.
    for (const s of [s1, s2]) {
      expect(s.framesOf('stream.closing')).toEqual([
        { schemaVersion: 1, type: 'stream.closing', reason: 'session_expired', retryAfterMs: 40 },
      ])
    }
  })

  it('T-SB61: a session window that has fired arms again for the next hint', async () => {
    b = await h.build()
    const [a, bUser] = [await h.createUser(), await h.createUser()]
    const sa = await ready(a, [await fileKey()])
    const sb = await ready(bUser, [await fileKey()])
    await forge('gfs_watch_session', `${a.userId}:retired:1`)
    await fire()
    expect(closings(sa)).toEqual([])
    await b.advance(1_000)

    await h.lifecycle.revokeAll(bUser.userId)
    await h.barrier()
    expect(b.registry.state.windows().sessionWindow).not.toBeNull()
    await fire()
    expect(closings(sb)).toEqual(['session_expired'])
    expect(held()).toEqual([])
  })

  it('T-SB62: stopRegistry releases a pending session hint and a fail-closed within its ceiling', async () => {
    b = await h.build()
    const [a, bUser] = [await h.createUser(), await h.createUser()]
    await ready(a, [await fileKey()])
    await ready(bUser, [await fileKey()])
    await forge('gfs_watch_session', `${a.userId}:retired:1`)
    await forge('gfs_authz_changed', 'x:garbage')
    expect(b.registry.state.holdUsers.get(a.userId)).toBe(2)
    expect(b.registry.state.holdUsers.get(bUser.userId)).toBe(1)
    b.registry.stop()
    const w = b.registry.state.windows()
    expect(held()).toEqual([])
    expect(w.sessionPending.size).toBe(0)
    expect(w.failClosedPending.size).toBe(0)
    expect(w.sessionWindow).toBeNull()
    expect(w.failClosedTimer).toBeNull()
  })

  it('stopRegistry with a confirmation in flight: the confirmation releases its own users and writes nothing', async () => {
    b = await h.build()
    const user = await h.createUser()
    const socket = await ready(user, [await fileKey()])
    b.gates.session.mode = 'hold'
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    await b.advance(300)
    await until(() => b.gates.session.held.length === 1)
    b.registry.stop()
    expect(held()).toEqual([user.userId])
    b.gates.session.mode = 'pass'
    b.gates.session.releaseAll()
    await until(() => held().length === 0)
    expect(closings(socket)).toEqual(['server_shutdown'])
  })

  // The epoch gate after the confirmation's await is hardening and is not
  // discriminated here: the retention refuses every admission of U until the
  // confirmation's finally, so when it resumes no connection of U exists, with
  // or without the gate.
  it('E11 with a confirmation in flight: the user stays out until the confirmation releases it in its finally', async () => {
    b = await h.build()
    const user = await h.createUser()
    const first = await ready(user, [await fileKey()])
    b.gates.session.mode = 'hold'
    await forge('gfs_watch_session', `${user.userId}:retired:1`)
    await b.advance(300)
    await until(() => b.gates.session.held.length === 1)
    expect(await h.terminateListener()).toBe(1)
    await until(() => !b.registry.listenerReady())
    expect(closings(first)).toEqual(['listener_lost'])
    await b.advance(1_200)
    await until(() => b.registry.listenerReady())
    // Retained by the confirmation still in flight: the reopen is refused for now.
    const refused = await b.open(user, [await fileKey()]).outcome
    expect(refused).toMatchObject({ kind: 'reply', status: 503, code: 'watch_reauthorize' })
    b.gates.session.failAll(new Error('Connection terminated unexpectedly'))
    await until(() => held().length === 0)
    const second = await ready(user, [await fileKey()])
    await b.settle()
    expect(closings(second)).toEqual([])
  })
})
