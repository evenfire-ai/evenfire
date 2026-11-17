import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type { GfsKey, Uuid } from '../src/services/gfsWatch/keys.js'
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
  restInvariantViolations!: Loaded['restInvariantViolations'],
  sleep!: Loaded['sleep']

// Scenario tests of the authorization window and the fail-closed of the GFS
// watch registry. Every NOTIFY comes from a committed write through the real
// gfs_authz_changed and gfs_resource_changed triggers (a forged payload only
// where the case is an unreadable one), every expansion runs on the real
// watch pool against real tables, and every assertion is on what the client
// sees: frames on the socket and the open's outcome. Registry internals are
// read only for the retention invariants (I35, I36) and the timer handles.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const CLOSING_KEYS = new Set(['schemaVersion', 'type', 'reason', 'retryAfterMs'])

describeRealPostgres('GFS watch authorization window on real Postgres', () => {
  let adminPool: Pool | undefined
  let h: RegistryHarness
  let b: BuiltRegistry
  let unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)
  const sockets: FakeSocket[] = []

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
    // After stop: its stream.closing writes are checked like any other frame.
    await b?.stop()
    const violations = b?.violations() ?? []
    // I11: a closing frame names nothing but its reason.
    for (const s of sockets.splice(0)) {
      for (const f of s.framesOf('stream.closing')) {
        for (const k of Object.keys(f)) if (!CLOSING_KEYS.has(k)) violations.push(`I11: ${k}`)
      }
    }
    const w = b?.registry.state.windows()
    h.decisions.clear()
    expect(violations).toEqual([])
    // stopRegistry leaves no window, retry, fail-closed or hold behind.
    expect(w?.authzWindow ?? null).toBeNull()
    expect(w?.expansionRetry ?? null).toBeNull()
    expect(w?.failClosedTimer ?? null).toBeNull()
    expect([...(w?.failClosedPending ?? [])]).toEqual([])
    expect([...(b?.registry.state.holdUsers.keys() ?? [])]).toEqual([])
    expect(unhandled).toEqual([])
    unhandled = []
  })

  async function ready(user: TestUser, keys: GfsKey[], build?: BuiltRegistry) {
    const reg = build ?? b
    const o = reg.open(user, keys)
    sockets.push(o.socket)
    const outcome = await o.outcome
    expect(outcome).toEqual({ kind: 'stream' })
    return { socket: o.socket, conn: reg.connOf(o.socket)! }
  }

  const until = (f: () => boolean, ms = 8_000) => b.settle(f, ms)
  const closings = (s: FakeSocket) => s.framesOf('stream.closing')
  const reauthorized = (s: FakeSocket) =>
    closings(s).some(f => f.reason === 'reauthorize') && s.ended > 0
  /** Fires the 250 ms window and waits for `n` expansion queries in total to settle. */
  async function fireWindow(expansionsDone?: number) {
    await b.advance(300)
    if (expansionsDone !== undefined) await until(() => b.gates.expansion.done >= expansionsDone)
    await until(() => b.registry.state.windows().authzWindow === null)
  }
  /** I36 without session hints: a hold is exactly membership of failClosedPending. */
  function i36(): string[] {
    const st = b.registry.state
    const pending = st.windows().failClosedPending
    const v: string[] = []
    for (const [uid, n] of st.holdUsers)
      if (n !== (pending.has(uid) ? 1 : 0)) v.push(`I36 ${uid}=${n}`)
    for (const uid of pending) if (st.holdUsers.get(uid) !== 1) v.push(`I36 ${uid} not held`)
    return v
  }

  it('T-S5: revoking a connected user’s grant closes with reauthorize; the reopen rejects the key', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const g = await h.authz.grant(f, 'user', user.userId)
    await h.barrier()
    const { socket } = await ready(user, [h.key('file', f)])
    expect(socket.last('ready')!.accepted).toEqual([h.key('file', f)])

    await h.authz.revoke(g)
    h.decisions.set(h.toRid(f), 'deny')
    await h.barrier()
    await fireWindow()
    await until(() => reauthorized(socket))
    expect(closings(socket)).toHaveLength(1)
    expect(socket.framesOf('changed')).toEqual([])

    const again = await ready(user, [h.key('file', f)])
    expect(again.socket.last('ready')!.rejected).toEqual([h.key('file', f)])
    expect(again.socket.last('ready')!.accepted).toEqual([])
    expect(restInvariantViolations(b)).toEqual([])
  })

  for (const order of ['window first', 'read first'] as const) {
    it(`T-S10: a revocation during the open’s authorization never leaves the key accepted (${order})`, async () => {
      b = await h.build()
      const user = await h.createUser()
      const f = await h.tree.add('file')
      const g = await h.authz.grant(f, 'user', user.userId)
      await h.barrier()
      b.gates.read.mode = 'hold'
      const o = b.open(user, [h.key('file', f)])
      sockets.push(o.socket)
      await until(() => b.gates.read.held.length === 1)

      // gfsc may still answer from before the revocation: the stand-in keeps allowing.
      await h.authz.revoke(g)
      await h.barrier()
      if (order === 'window first') {
        await fireWindow()
        b.gates.read.mode = 'pass'
        b.gates.read.releaseAll()
      } else {
        b.gates.read.mode = 'pass'
        b.gates.read.releaseAll()
        await until(() => o.settled())
        await fireWindow()
      }
      const outcome = await o.outcome
      expect(outcome).toMatchObject({ kind: 'reply', status: 503, code: 'watch_reauthorize' })
      expect(o.socket.framesOf('ready')).toEqual([])
      expect(o.socket.headersSent).toBe(false)
      expect(b.registry.state.byConnId.size).toBe(0)
    })
  }

  it('T-S11: a stream opened while the team expansion is in flight is reauthorized too', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const first = await ready(user, [h.key('file', f)])

    b.gates.expansion.mode = 'hold'
    await h.authz.grant(f, 'team', user.teamId)
    await h.barrier()
    await b.advance(300)
    await until(() => b.gates.expansion.held.length === 1)
    // Not retained yet: the team is not expanded, so the open completes.
    const second = await ready(user, [h.key('file', f)])
    b.gates.expansion.mode = 'pass'
    b.gates.expansion.releaseAll()
    await until(() => reauthorized(first.socket) && reauthorized(second.socket))
    expect(closings(first.socket)).toHaveLength(1)
    expect(closings(second.socket)).toHaveLength(1)
  })

  it('T-S12: 100 grants per transaction to two teams and a user give one reauthorize per connection and one expansion query', async () => {
    b = await h.build()
    const [u1, u2, u3, u4] = [
      await h.createUser(),
      await h.createUser(),
      await h.createUser(),
      await h.createUser(),
    ]
    const team = await h.authz.createTeam()
    const team2 = await h.authz.createTeam()
    await h.authz.join(team, u1.userId)
    await h.authz.join(team, u2.userId)
    await h.authz.join(team2, u4.userId)
    const files = await Promise.all(Array.from({ length: 100 }, () => h.tree.add('file')))
    await h.barrier()
    const c1 = await ready(u1, [h.key('file', files[0]!)])
    const c1b = await ready(u1, [h.key('file', files[1]!)])
    const c2 = await ready(u2, [h.key('file', files[0]!)])
    const c3 = await ready(u3, [h.key('file', files[0]!)])
    const c4 = await ready(u4, [h.key('file', files[0]!)])
    const before = b.gates.expansion.calls

    await h.authz.grantMany(files, 'team', team)
    await h.authz.grantMany(files, 'team', team2)
    await h.authz.grantMany(files, 'user', u3.userId)
    await h.barrier()
    await fireWindow(1)
    const all = [c1, c1b, c2, c3, c4]
    await until(() => all.every(c => reauthorized(c.socket)))
    // Another window passes with nothing more to close.
    await b.advance(600)
    for (const c of all) expect(closings(c.socket)).toHaveLength(1)
    // Five victims, spread over 5 × 40 ms; the virtual clock's random is 0.5.
    for (const c of all) expect(closings(c.socket)[0]!.retryAfterMs).toBe(100)
    expect(b.gates.expansion.calls - before).toBe(1)
  })

  it('T-S16: a grant to user B reauthorizes B and leaves A untouched; non-user subjects reach nobody', async () => {
    b = await h.build()
    const [a, bUser] = [await h.createUser(), await h.createUser()]
    const f = await h.tree.add('file')
    const ca = await ready(a, [h.key('file', f)])
    const cb = await ready(bUser, [h.key('file', f)])
    const calls = b.gates.expansion.calls

    await h.authz.grant(f, 'operator', '')
    await h.authz.grant(f, 'host', `host-${randomUUID()}`)
    await h.authz.grant(f, 'context', `ctx:${randomUUID()}`)
    await h.barrier()
    await b.advance(600)
    expect(b.registry.state.windows().authzWindow).toBeNull()
    expect(closings(ca.socket)).toEqual([])
    expect(closings(cb.socket)).toEqual([])

    await h.authz.grant(f, 'user', bUser.userId)
    await h.barrier()
    // A change on f arrives in the same window: A, unaffected, still gets it.
    await h.tree.rename(f)
    await h.barrier()
    await fireWindow()
    await until(() => reauthorized(cb.socket) && ca.socket.framesOf('changed').length === 1)
    expect(closings(ca.socket)).toEqual([])
    expect(ca.conn.phase).toBe('ready')
    expect(cb.socket.framesOf('changed')).toEqual([])
    expect(b.gates.expansion.calls).toBe(calls)
  })

  it('T-S23: moving an inherited ancestor or soft-deleting it reauthorizes the reader; other subtrees and the op in flight do not', async () => {
    b = await h.build()
    const user = await h.createUser()
    const A = await h.tree.add('directory')
    const B = await h.tree.add('directory')
    const S = await h.tree.add('directory', A)
    const f = await h.tree.add('file', S)
    const other = await h.tree.add('directory')
    const elsewhere = await h.tree.add('directory', other)
    // A reader of an unrelated subtree, created before any stream is open:
    // its membership write would otherwise retain it for one window.
    const reader = await h.createUser()
    await h.authz.grant(A, 'user', user.userId)
    await h.barrier()
    const c = await ready(user, [h.key('file', f)])
    const bystander = await ready(reader, [h.key('dir', other)])

    await h.tree.move(elsewhere, B)
    await h.barrier()
    await b.advance(600)
    expect(closings(c.socket)).toEqual([])
    expect(closings(bystander.socket)).toEqual([])

    await h.tree.move(S, B)
    h.decisions.set(h.toRid(f), 'deny')
    await h.barrier()
    await fireWindow()
    await until(() => reauthorized(c.socket))
    const reopened = await ready(user, [h.key('file', f)])
    expect(reopened.socket.last('ready')!.rejected).toEqual([h.key('file', f)])

    h.decisions.delete(h.toRid(f))
    await h.tree.move(S, A)
    await h.barrier()
    await b.advance(600)
    // A rejected key is not indexed: moving it back produces no frame.
    expect(closings(reopened.socket)).toEqual([])
    // Past the suspect horizon of the recent move, so the open decides.
    await b.advance(6_500)
    const third = await ready(user, [h.key('file', f)])
    expect(third.socket.last('ready')!.accepted).toEqual([h.key('file', f)])
    await h.tree.softDelete(A)
    await h.barrier()
    await fireWindow()
    await until(() => reauthorized(third.socket))
    expect(closings(bystander.socket)).toEqual([])
  })

  it('T-S23: an ancestry change during a delta leaves its keys to the suspect marking, not to reauthorize', async () => {
    b = await h.build()
    const user = await h.createUser()
    const A = await h.tree.add('directory')
    const B = await h.tree.add('directory')
    const f = await h.tree.add('file', A)
    const f2 = await h.tree.add('file', A)
    const g = await h.tree.add('file')
    const c = await ready(user, [h.key('file', g)])
    b.gates.read.mode = 'hold'
    await h.notifyCmd({
      c: c.conn.connId,
      s: 1,
      u: c.conn.binding.userId,
      g: c.conn.binding.authGeneration,
      r: randomUUID() as Uuid,
      keys: new Set([h.key('file', g), h.key('file', f), h.key('file', f2)]),
    })
    await until(() => b.gates.read.held.length === 2)
    // f is decided (accepted) while the op still waits for f2.
    b.gates.read.releaseWhere(`read:${h.toRid(f)}`)
    await until(() => c.conn.keys.get(h.key('file', f))?.state === 'accepted')
    await h.tree.move(A, B)
    await h.barrier()
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await until(() => c.socket.framesOf('subscriptions').length === 1)
    await b.advance(600)
    expect(new Set(c.socket.last('subscriptions')!.deferred as string[])).toEqual(
      new Set([h.key('file', f), h.key('file', f2)])
    )
    expect(closings(c.socket)).toEqual([])
  })

  /** Routes a delta and waits until the key `inFlight` is indexed and authorizing. */
  async function deltaInFlight(
    conn: { connId: string; binding: { userId: Uuid; authGeneration: number } },
    keys: GfsKey[],
    inFlight: GfsKey
  ) {
    b.gates.read.mode = 'hold'
    await h.notifyCmd({
      c: conn.connId,
      s: 1,
      u: conn.binding.userId,
      g: conn.binding.authGeneration,
      r: randomUUID() as Uuid,
      keys: new Set(keys),
    })
    const c = b.registry.state.byConnId.get(conn.connId)!
    await until(() => b.gates.read.held.length === 1 && c.keys.get(inFlight)?.chain != null)
  }

  it('T-S23: a rejected key on the moved rid does not reauthorize; the key in flight on it ends deferred', async () => {
    b = await h.build()
    const user = await h.createUser()
    const B = await h.tree.add('directory')
    const F = await h.tree.add('file')
    const g = await h.tree.add('file')
    // dir:F names a file: gfsc's view kind does not match and it stays rejected, unindexed.
    const c = await ready(user, [h.key('dir', F), h.key('file', g)])
    expect(c.socket.last('ready')!.rejected).toEqual([h.key('dir', F)])
    await deltaInFlight(
      c.conn,
      [h.key('dir', F), h.key('file', g), h.key('file', F)],
      h.key('file', F)
    )
    await h.tree.move(F, B)
    await h.barrier()
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await until(() => c.socket.framesOf('subscriptions').length === 1)
    await b.advance(600)
    expect(c.socket.last('subscriptions')!.deferred).toEqual([h.key('file', F)])
    expect(closings(c.socket)).toEqual([])
    expect(c.conn.phase).toBe('ready')
  })

  it('T-S23: a rejected directory key whose subtree holds a key in flight does not reauthorize on its move', async () => {
    b = await h.build()
    const user = await h.createUser()
    const B = await h.tree.add('directory')
    const D = await h.tree.add('directory')
    const f = await h.tree.add('file', D)
    const g = await h.tree.add('file')
    h.decisions.set(h.toRid(D), 'deny')
    const c = await ready(user, [h.key('dir', D), h.key('file', g)])
    expect(c.socket.last('ready')!.rejected).toEqual([h.key('dir', D)])
    await deltaInFlight(
      c.conn,
      [h.key('dir', D), h.key('file', g), h.key('file', f)],
      h.key('file', f)
    )
    await h.tree.move(D, B)
    await h.barrier()
    b.gates.read.mode = 'pass'
    b.gates.read.releaseAll()
    await until(() => c.socket.framesOf('subscriptions').length === 1)
    await b.advance(600)
    expect(c.socket.last('subscriptions')!.deferred).toEqual([h.key('file', f)])
    expect(closings(c.socket)).toEqual([])
    expect(c.conn.phase).toBe('ready')
  })

  it('T-S23: a linked operator is never reauthorized by an ancestry change', async () => {
    const flag = h.modules.config.config.desktopGfsOperatorLinkingEnabled
    h.modules.config.config.desktopGfsOperatorLinkingEnabled = true
    try {
      b = await h.build()
      const op = await h.createUser()
      const admin = await h.authz.createAdmin()
      await h.authz.link(op.userId, admin)
      const user = await h.createUser()
      const A = await h.tree.add('directory')
      const B = await h.tree.add('directory')
      const f = await h.tree.add('file', A)
      await h.barrier()
      const co = await ready(op, [h.key('file', f)])
      expect(co.conn.principalKind).toBe('linked_operator')
      const cu = await ready(user, [h.key('file', f)])
      await h.tree.move(A, B)
      await h.barrier()
      await fireWindow()
      await until(() => reauthorized(cu.socket))
      expect(closings(co.socket)).toEqual([])
      expect(co.conn.phase).toBe('ready')
    } finally {
      h.modules.config.config.desktopGfsOperatorLinkingEnabled = flag
    }
  })

  it('T-S26: a change and a revocation in the same window: no changed before the reauthorize', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const g = await h.authz.grant(f, 'user', user.userId)
    await h.barrier()
    const c = await ready(user, [h.key('file', f)])
    // The change first, so its flush is armed before the window.
    await h.tree.rename(f)
    await h.authz.revoke(g)
    await h.barrier()
    await fireWindow()
    await until(() => reauthorized(c.socket))
    expect(c.socket.frames.map(fr => fr.type)).toEqual(['ready', 'stream.closing'])
  })

  it('T-S27: an admin change reaches users linked to it, never one whose link was revoked', async () => {
    b = await h.build()
    const [revoked, linked] = [await h.createUser(), await h.createUser()]
    const [adminR, adminL] = [await h.authz.createAdmin(), await h.authz.createAdmin()]
    await h.authz.link(revoked.userId, adminR)
    await h.authz.unlink(revoked.userId, adminR)
    await h.authz.link(linked.userId, adminL)
    const f = await h.tree.add('file')
    await h.barrier()
    const cr = await ready(revoked, [h.key('file', f)])
    const cl = await ready(linked, [h.key('file', f)])

    await h.authz.bumpAdmin(adminR)
    await h.barrier()
    const calls = b.gates.expansion.done
    await fireWindow(calls + 1)
    await b.advance(600)
    expect(closings(cr.socket)).toEqual([])

    await h.authz.bumpAdmin(adminL)
    await h.barrier()
    await fireWindow(calls + 2)
    await until(() => reauthorized(cl.socket))
    expect(closings(cr.socket)).toEqual([])
    expect(cr.conn.phase).toBe('ready')
  })

  /** Holds team_members exclusively, so the expansion query blocks until something ends it. */
  async function lockTeams(): Promise<PoolClient> {
    const client = await h.writer.connect()
    await client.query('BEGIN')
    await client.query('LOCK TABLE team_members IN ACCESS EXCLUSIVE MODE')
    return client
  }
  async function unlock(client: PoolClient) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  /** Cancels each blocked expansion as it arrives: a real statement abort (57014). */
  function cancelExpansions() {
    let on = true
    const loop = (async () => {
      while (on) {
        await adminPool!.query(
          `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND wait_event_type = 'Lock'
              AND query LIKE 'SELECT user_id::text AS u FROM team_members%'`,
          [registryTestDatabase]
        )
        await sleep(5)
      }
    })()
    return async () => {
      on = false
      await loop
    }
  }

  /**
   * One fail-closed through the real path: a team key whose window and retry
   * are both cancelled. Needs `lockTeams` and `cancelExpansions` running.
   */
  async function failOnce(_f: string, team: string, violations: string[] = []) {
    // A fresh resource each time: a subject holds one grant per resource.
    await h.authz.grant(await h.tree.add('file'), 'team', team)
    await h.barrier()
    const d0 = b.gates.expansion.done
    await b.advance(300)
    await until(() => b.gates.expansion.done > d0)
    violations.push(...i36())
    b.clock.advance(500)
    await until(() => b.gates.expansion.done > d0 + 1)
    await until(() => b.registry.state.windows().expansionRetry === null)
    violations.push(...i36())
  }

  it('T-SB80: two failed windows of different teams share one retry that expands both', async () => {
    b = await h.build()
    const [a, c] = [await h.createUser(), await h.createUser()]
    const [t1, t2] = [await h.authz.createTeam(), await h.authz.createTeam()]
    await h.authz.join(t1, a.userId)
    await h.authz.join(t2, c.userId)
    const f = await h.tree.add('file')
    const ca = await ready(a, [h.key('file', f)])
    const cc = await ready(c, [h.key('file', f)])
    b.gates.expansion.mode = 'hold'
    await h.authz.grant(f, 'team', t1)
    await h.barrier()
    await b.advance(300)
    await until(() => b.gates.expansion.held.length === 1)
    await h.authz.grant(f, 'team', t2)
    await h.barrier()
    await b.advance(300)
    await until(() => b.gates.expansion.held.length === 2)
    const d = b.gates.expansion.done
    b.gates.expansion.failAll(new Error('Query read timeout'))
    await until(() => b.gates.expansion.done === d + 2)
    const w = b.registry.state.windows()
    expect(w.expansionRetry).not.toBeNull()
    expect(new Set(w.retryTeams)).toEqual(new Set([t1, t2]))
    b.gates.expansion.mode = 'pass'
    await b.advance(500)
    await until(() => reauthorized(ca.socket) && reauthorized(cc.socket))
    expect(b.registry.state.holdUsers.size).toBe(0)
  })

  it('T-SB21: a team expansion that fails twice reauthorizes every user, in the team or not', async () => {
    b = await h.build()
    const [inTeam, outside] = [await h.createUser(), await h.createUser()]
    const f = await h.tree.add('file')
    const ci = await ready(inTeam, [h.key('file', f)])
    const co = await ready(outside, [h.key('file', f)])
    const lock = await lockTeams()
    const stop = cancelExpansions()
    try {
      await h.authz.grant(f, 'team', inTeam.teamId)
      await h.barrier()
      await fireWindow(b.gates.expansion.done + 1)
      expect(b.registry.state.windows().expansionRetry).not.toBeNull()
      expect(b.registry.state.holdUsers.size).toBe(0)
      const done = b.gates.expansion.done
      b.clock.advance(500)
      await until(() => b.gates.expansion.done > done)
      await until(() => b.registry.state.holdUsers.size === 2)
      // Retained at once: a change on the key no longer goes out.
      await h.tree.rename(f)
      await h.barrier()
      await b.advance(300)
      await until(() => reauthorized(ci.socket) && reauthorized(co.socket))
    } finally {
      await stop()
      await unlock(lock)
    }
    for (const c of [ci, co]) {
      expect(c.socket.frames.map(fr => fr.type)).toEqual(['ready', 'stream.closing'])
      // Two victims spread over 2 × 40 ms; the virtual clock's random is 0.5.
      expect(closings(c.socket)[0]!.retryAfterMs).toBe(40)
    }
    expect(b.registry.state.holdUsers.size).toBe(0)
    expect(i36()).toEqual([])
  })

  it('T-SB21: with the expansion stalled on statement_timeout both times, retention starts within 8.75 s and nothing is sent after', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const c = await ready(user, [h.key('file', f)])
    const lock = await lockTeams()
    let heldAfterMs = Number.POSITIVE_INFINITY
    try {
      await h.authz.grant(f, 'team', user.teamId)
      await h.barrier()
      const t0 = Date.now()
      // The virtual clock follows real time in 50 ms steps, so the window,
      // the retry delay and both statement timeouts add up as in production.
      while (Date.now() - t0 < 12_000) {
        await b.advance(50)
        await sleep(40)
        if (b.registry.state.holdUsers.size > 0) {
          heldAfterMs = Date.now() - t0
          break
        }
      }
      await h.tree.rename(f)
      await h.barrier()
      await b.advance(300)
    } finally {
      await unlock(lock)
    }
    expect(heldAfterMs).toBeLessThanOrEqual(8_750)
    await until(() => reauthorized(c.socket))
    expect(c.socket.frames.map(fr => fr.type)).toEqual(['ready', 'stream.closing'])
  }, 30_000)

  it('T-SB21: three fail-closed within the ceiling apply once, at the ceiling, and hold changes meanwhile', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const team = await h.authz.createTeam()
    await h.authz.join(team, user.userId)
    const first = await ready(user, [h.key('file', f)])
    const metric = async () =>
      (await h.modules.metrics.gfsWatchExpansionFailclosedTotal.get()).values.reduce(
        (n, v) => n + v.value,
        0
      )
    const m0 = await metric()
    const violations: string[] = []
    const lock = await lockTeams()
    const stop = cancelExpansions()
    let second: Awaited<ReturnType<typeof ready>>
    let t1 = 0
    try {
      // No fail-closed before this one: it applies at once.
      await failOnce(f, team, violations)
      await b.advance(10)
      await until(() => reauthorized(first.socket))
      t1 = b.clock.now()
      second = await ready(user, [h.key('file', f)])
      await failOnce(f, team, violations)
      await failOnce(f, team, violations)
      await failOnce(f, team, violations)
    } finally {
      await stop()
      await unlock(lock)
    }
    expect(b.registry.state.holdUsers.get(user.userId)).toBe(1)
    await h.tree.rename(f)
    await h.barrier()
    await b.advance(500)
    expect(second.socket.framesOf('changed')).toEqual([])
    expect(closings(second.socket)).toEqual([])
    await b.advance(t1 + 5_000 - b.clock.now() - 50)
    expect(closings(second.socket)).toEqual([])
    await b.advance(100)
    await until(() => reauthorized(second.socket))
    expect(second.socket.frames.map(fr => fr.type)).toEqual(['ready', 'stream.closing'])
    expect((await metric()) - m0).toBe(4)
    expect(b.registry.state.holdUsers.size).toBe(0)
    expect(violations).toEqual([])
  }, 60_000)

  it('T-SB60: overlapping fail-closed and a user who leaves before the ceiling end with no holds and live streams', async () => {
    b = await h.build()
    const [A, B] = [await h.createUser(), await h.createUser()]
    const f = await h.tree.add('file')
    const team = await h.authz.createTeam()
    await h.authz.join(team, A.userId)
    await ready(A, [h.key('file', f)])
    await ready(B, [h.key('file', f)])
    const lock = await lockTeams()
    const stop = cancelExpansions()
    const violations: string[] = []
    let a1: Awaited<ReturnType<typeof ready>>
    try {
      // t0: nothing applied before, so this one closes both at once.
      await failOnce(f, team, violations)
      await b.advance(10)
      await until(() => b.registry.state.byConnId.size === 0)
      violations.push(...i36())
      a1 = await ready(A, [h.key('file', f)])
      const b1 = await ready(B, [h.key('file', f)])
      await b.advance(400)
      await failOnce(f, team, violations) // t0 + 1 s: within the ceiling, held until t0 + 5 s
      await b.advance(500)
      b1.socket.emitGone() // t0 + 1.5 s
      violations.push(...i36())
      await failOnce(f, team, violations) // t0 + 2 s
      expect(b.registry.state.holdUsers.get(A.userId)).toBe(1)
      expect(b.registry.state.holdUsers.get(B.userId)).toBe(1)
    } finally {
      await stop()
      await unlock(lock)
    }
    await b.advance(3_500)
    await until(() => reauthorized(a1.socket))
    violations.push(...i36())
    expect(b.registry.state.holdUsers.size).toBe(0)
    expect(b.registry.state.windows().failClosedPending.size).toBe(0)
    expect(b.registry.state.windows().failClosedTimer).toBeNull()

    const a2 = await ready(A, [h.key('file', f)])
    const b2 = await ready(B, [h.key('file', f)])
    await h.tree.rename(f)
    await h.barrier()
    await b.advance(300)
    await until(
      () => a2.socket.framesOf('changed').length === 1 && b2.socket.framesOf('changed').length === 1
    )
    expect(violations).toEqual([])
  }, 60_000)

  it('T-SB62: stopRegistry with a pending window and a fail-closed inside the ceiling releases every hold', async () => {
    b = await h.build()
    const [A, B] = [await h.createUser(), await h.createUser()]
    const f = await h.tree.add('file')
    const first = await ready(A, [h.key('file', f)])
    await h.writer.query(`SELECT pg_notify('gfs_authz_changed', 'x:unreadable')`)
    await h.barrier()
    await b.advance(10)
    await until(() => reauthorized(first.socket))
    await ready(A, [h.key('file', f)])
    await ready(B, [h.key('file', f)])
    await h.writer.query(`SELECT pg_notify('gfs_authz_changed', 'x:unreadable')`)
    await h.authz.grant(f, 'team', A.teamId)
    await h.barrier()
    const w = b.registry.state.windows()
    expect(w.failClosedTimer).not.toBeNull()
    expect(w.authzWindow).not.toBeNull()
    expect([...w.authzTeams]).toEqual([A.teamId])
    expect(b.registry.state.holdUsers.size).toBe(2)
    b.registry.stop()
    // afterEach asserts the rest: no handle, no pending reason, no hold.
    expect(b.clock.isPending(w.failClosedTimer)).toBe(false)
    expect(b.clock.isPending(w.authzWindow)).toBe(false)
    expect(b.registry.state.windows().authzTeams.size).toBe(0)
  })

  it('T-SB100: a listener loss drops the pending window and the one in its await; new streams are not reauthorized', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    await ready(user, [h.key('file', f)])
    b.gates.expansion.mode = 'hold'
    await h.authz.grant(f, 'team', user.teamId)
    await h.barrier()
    await b.advance(300)
    await until(() => b.gates.expansion.held.length === 1)
    await h.authz.grant(await h.tree.add('file'), 'team', user.teamId)
    await h.writer.query(`SELECT pg_notify('gfs_authz_changed', 'x:unreadable')`)
    await h.barrier()
    expect(b.registry.state.windows().authzWindow).not.toBeNull()
    expect(b.registry.state.holdUsers.get(user.userId)).toBe(1)
    const epoch = b.registry.state.windows().windowEpoch

    expect(await h.terminateListener()).toBe(1)
    await until(() => !b.registry.listenerReady())
    expect(b.registry.state.windows().windowEpoch).toBe(epoch + 1)
    expect(b.registry.state.holdUsers.size).toBe(0)
    b.clock.advance(1_200)
    await until(() => b.registry.listenerReady())

    const fresh = await ready(user, [h.key('file', f)])
    b.gates.expansion.mode = 'pass'
    b.gates.expansion.releaseAll()
    await until(() => b.gates.expansion.held.length === 0)
    await b.advance(6_000)
    expect(closings(fresh.socket)).toEqual([])
    expect(fresh.conn.phase).toBe('ready')
    expect(b.registry.state.holdUsers.size).toBe(0)
  })

  it('T-SB100: a listener loss while the expansion retry is in its await: the retry does not write', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    await ready(user, [h.key('file', f)])
    b.gates.expansion.mode = 'fail'
    b.gates.expansion.failWith = () => {
      b.gates.expansion.mode = 'hold'
      return new Error('Connection terminated unexpectedly')
    }
    await h.authz.grant(f, 'team', user.teamId)
    await h.barrier()
    await fireWindow(b.gates.expansion.done + 1)
    expect(b.registry.state.windows().expansionRetry).not.toBeNull()
    b.clock.advance(500)
    await until(() => b.gates.expansion.held.length === 1)

    expect(await h.terminateListener()).toBe(1)
    await until(() => !b.registry.listenerReady())
    b.clock.advance(1_200)
    await until(() => b.registry.listenerReady())
    const fresh = await ready(user, [h.key('file', f)])
    b.gates.expansion.mode = 'pass'
    b.gates.expansion.releaseAll()
    await until(() => b.gates.expansion.held.length === 0)
    await b.advance(6_000)
    expect(closings(fresh.socket)).toEqual([])
    expect(b.registry.state.holdUsers.size).toBe(0)
  })

  it('a window past its id cap fails closed at once, with no expansion of the burst', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const c = await ready(user, [h.key('file', f)])
    const metric = async () =>
      (await h.modules.metrics.gfsWatchExpansionFailclosedTotal.get()).values.reduce(
        (n, v) => n + v.value,
        0
      )
    const m0 = await metric()
    const calls = b.gates.expansion.calls
    const cap = h.modules.registry.GFS_WATCH_AUTHZ_WINDOW_MAX_IDS
    // One transaction of distinct team keys, one past the cap: real NOTIFYs,
    // delivered at commit like any other writer's.
    await h.writer.query(
      `SELECT pg_notify('gfs_authz_changed', 's:team:' || gen_random_uuid()::text)
         FROM generate_series(1, $1::int)`,
      [cap + 1]
    )
    await h.barrier()
    expect(b.registry.state.windows().authzTeams.size).toBe(0)
    expect(b.registry.state.holdUsers.get(user.userId)).toBe(1)
    expect((await metric()) - m0).toBe(1)
    await b.advance(600)
    await until(() => reauthorized(c.socket))
    expect(b.gates.expansion.calls).toBe(calls)
    expect(b.registry.state.holdUsers.size).toBe(0)
  }, 60_000)

  it('failed windows that only together pass the id cap fail closed instead of retrying them all', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const c = await ready(user, [h.key('file', f)])
    const metric = async () =>
      (await h.modules.metrics.gfsWatchExpansionFailclosedTotal.get()).values.reduce(
        (n, v) => n + v.value,
        0
      )
    const m0 = await metric()
    const cap = h.modules.registry.GFS_WATCH_AUTHZ_WINDOW_MAX_IDS
    const perWindow = Math.ceil(cap * 0.6)
    const burst = () =>
      h.writer.query(
        `SELECT pg_notify('gfs_authz_changed', 's:team:' || gen_random_uuid()::text)
           FROM generate_series(1, $1::int)`,
        [perWindow]
      )
    b.gates.expansion.mode = 'hold'
    for (let i = 1; i <= 2; i += 1) {
      await burst()
      await h.barrier()
      await b.advance(300)
      await until(() => b.gates.expansion.held.length === i)
    }
    expect(await metric()).toBe(m0)
    const d = b.gates.expansion.done
    b.gates.expansion.failAll(new Error('Query read timeout'))
    await until(() => b.gates.expansion.done === d + 2)
    const w = b.registry.state.windows()
    expect(w.retryTeams.size).toBe(0)
    expect(w.expansionRetry).not.toBeNull()
    expect(b.registry.state.holdUsers.get(user.userId)).toBe(1)
    expect((await metric()) - m0).toBe(1)
    b.gates.expansion.mode = 'pass'
    const calls = b.gates.expansion.calls
    await b.advance(600)
    await until(() => reauthorized(c.socket))
    // The retry ran with nothing to expand: no query carries the accumulated ids.
    expect(b.gates.expansion.calls).toBe(calls)
    expect(b.registry.state.windows().expansionRetry).toBeNull()
    expect(b.registry.state.holdUsers.size).toBe(0)
  }, 60_000)

  it('a team grant while nobody is connected expands nothing', async () => {
    b = await h.build()
    const user = await h.createUser()
    const f = await h.tree.add('file')
    const calls = b.gates.expansion.calls
    await h.authz.grant(f, 'team', user.teamId)
    await h.barrier()
    expect(b.registry.state.windows().authzWindow).toBeNull()
    await b.advance(600)
    expect(b.gates.expansion.calls).toBe(calls)
  })
})
