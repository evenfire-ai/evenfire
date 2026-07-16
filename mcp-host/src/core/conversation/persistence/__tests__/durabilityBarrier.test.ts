/**
 * D3 (stateless-agents) — durability barrier tests.
 *
 *  1. Turn boundaries go through the synchronous awaited path (`enqueueSync`)
 *     as ONE `persist_turn_boundary` op each — production wiring, no flag.
 *  2. The boundary is ONE SQLite transaction: a worker-level failure leaves
 *     the (message, active_task_id, state) triple untouched — never torn.
 *  3. Exactly-once retry: replay from the last persisted user message after a
 *     crash yields exactly ONE completed turn (row counts, not presence).
 *  4. Fault injection at the worker: a rejected commit fails the turn and the
 *     error propagates — never swallowed into a warn.
 *  5. `PRAGMA synchronous` barrier mode (FULL vs NORMAL) + micro-bench.
 *  6. §15 node-loss (power-loss / fsync-fault): under synchronous=FULL an
 *     ACKed turn survives a simulated power loss + replay exactly once, and a
 *     turn whose process died before the commit ACK leaves NO half-committed
 *     row — replay is exactly-once. Single-node deterministic proof of the
 *     node-loss criterion (no minikube taint needed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyPragmas } from '../../../../db/pragmas'
import type { WorkerMessage, WorkerOp, WorkerReply } from '../../../../db/worker/protocol'
import { ConversationManager } from '../../conversation'
import { PersistQueue, type WorkerLike } from '../persistQueue'
import { SqliteConversationStore } from '../sqliteConversationStore'
import { createInProcessWorker, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-d3:rpc:agent:default'

/**
 * WorkerLike wrapper that (when armed) rejects the next `persist_turn_boundary`
 * op at the worker boundary — simulating an fsync/commit failure. Everything
 * else passes through to the real in-process worker. Test-only dependency
 * injection: production code is untouched.
 */
class FaultInjectingWorker implements WorkerLike {
  private readonly messageListeners: Array<(reply: WorkerReply) => void> = []
  private failNextBoundary = false
  private dropNextBoundaryAck = false
  /** Message ids whose real ACK must be swallowed (power-loss model). */
  private readonly suppressedAckIds = new Set<string>()
  private innerSubscribed = false

  constructor(private readonly inner: WorkerLike) {}

  armNextBoundaryFailure(): void {
    this.failNextBoundary = true
  }

  /**
   * §15 power-loss model: forward the next boundary op to the real worker so it
   * COMMITS durably (synchronous=FULL fsyncs the WAL), but swallow its ACK — the
   * process is treated as dead the instant after the durable commit, before the
   * reply reached the caller. Distinct from armNextBoundaryFailure(), which
   * rejects BEFORE the commit. Proves an ACKed-in-storage boundary is atomic and
   * survives replay.
   */
  dropNextBoundaryAckAfterCommit(): void {
    this.dropNextBoundaryAck = true
  }

  private ensureInnerSubscribed(): void {
    if (this.innerSubscribed) return
    this.innerSubscribed = true
    this.inner.on('message', (reply: WorkerReply) => {
      if (this.suppressedAckIds.delete(reply.id)) return
      for (const listener of this.messageListeners) listener(reply)
    })
  }

  postMessage(msg: WorkerMessage): void {
    if (this.failNextBoundary && msg.op.kind === 'persist_turn_boundary') {
      this.failNextBoundary = false
      queueMicrotask(() => {
        const reply: WorkerReply = {
          id: msg.id,
          ok: false,
          error: { code: 'SQLITE_IOERR_FSYNC', message: 'simulated fsync failure' },
        }
        for (const listener of this.messageListeners) listener(reply)
      })
      return
    }
    if (this.dropNextBoundaryAck && msg.op.kind === 'persist_turn_boundary') {
      this.dropNextBoundaryAck = false
      // Commit for real, but mark this id so its ACK is dropped on the way back.
      this.suppressedAckIds.add(msg.id)
    }
    this.inner.postMessage(msg)
  }

  on(event: 'message', listener: (reply: WorkerReply) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  on(event: string, listener: (...args: never[]) => void): void {
    if (event === 'message') {
      // The wrapper is the SOLE message router: real replies are re-dispatched
      // through ensureInnerSubscribed() (honouring the ACK-suppression set),
      // NOT forwarded straight to inner — otherwise a dropped ACK would still
      // leak to the queue.
      this.messageListeners.push(listener as unknown as (reply: WorkerReply) => void)
      this.ensureInnerSubscribed()
      return
    }
    ;(this.inner.on as (e: string, l: unknown) => void)(event, listener)
  }

  terminate(): Promise<number> | void {
    return this.inner.terminate()
  }
}

function assistantRowCounts(db: Database.Database, sessionId: string) {
  const stop = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant' AND finish_reason = 'stop'"
    )
    .get(sessionId) as { n: number }
  const user = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'")
    .get(sessionId) as { n: number }
  const session = db
    .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
    .get(sessionId) as { state: string; active_task_id: string | null }
  return { assistantStop: stop.n, user: user.n, session }
}

describe('D3 durability barrier', () => {
  const tmpDirs: string[] = []

  function tmpDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-d3-'))
    tmpDirs.push(dir)
    return path.join(dir, 'state.db')
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  describe('PRAGMA synchronous barrier mode', () => {
    it('defaults to NORMAL without barrier mode', () => {
      const db = new Database(':memory:')
      const result = applyPragmas(db)
      expect(result.synchronous).toBe('NORMAL')
      expect(db.pragma('synchronous', { simple: true })).toBe(1)
      db.close()
    })

    it('applies FULL when barrierMode is enabled', () => {
      const db = new Database(':memory:')
      const result = applyPragmas(db, { barrierMode: true })
      expect(result.synchronous).toBe('FULL')
      expect(db.pragma('synchronous', { simple: true })).toBe(2)
      db.close()
    })
  })

  describe('turn boundaries take the awaited sync path — production wiring, no flag', () => {
    it('persistTurnStart + persistTurnComplete are ONE enqueueSync persist_turn_boundary op each', async () => {
      const handle = makeSqliteStore()
      const syncSpy = vi.spyOn(handle.persistQueue, 'enqueueSync')
      const asyncSpy = vi.spyOn(handle.persistQueue, 'enqueueAsync')
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      syncSpy.mockClear()
      asyncSpy.mockClear()

      await manager.startTurn(conv, 'hello', 'task-1')
      await manager.completeTurn(conv, 'world')

      const boundaryOps = syncSpy.mock.calls
        .map(call => call[0] as WorkerOp)
        .filter(op => op.kind === 'persist_turn_boundary')
      expect(boundaryOps).toHaveLength(2)
      expect(boundaryOps[0]).toMatchObject({ state: 'processing', activeTaskId: 'task-1' })
      expect(boundaryOps[1]).toMatchObject({ state: 'idle', activeTaskId: null })

      // The former two-op fire-and-forget pair must be gone: no async
      // insert_message / update_session_state for the boundary.
      const leakedAsyncOps = asyncSpy.mock.calls
        .map(call => call[1] as WorkerOp)
        .filter(op => op.kind === 'insert_message' || op.kind === 'update_session_state')
      expect(leakedAsyncOps).toHaveLength(0)

      const counts = assistantRowCounts(handle.worker.db, conv.id)
      expect(counts.user).toBe(1)
      expect(counts.assistantStop).toBe(1)
      expect(counts.session).toEqual({ state: 'idle', active_task_id: null })
    })

    it('persistTurnCancel is ONE atomic persist_turn_boundary op (no torn active_task_id)', async () => {
      // C1 regression: a torn cancel (two separate async ops) could crash
      // between the message insert and the state/active_task_id clear, leaving
      // active_task_id dirty on an 'idle' session that no boot reaper matches —
      // the D8 gate would then report activeWork forever and the Host would
      // never suspend. The cancel path MUST be a single atomic boundary.
      const handle = makeSqliteStore()
      const syncSpy = vi.spyOn(handle.persistQueue, 'enqueueSync')
      const asyncSpy = vi.spyOn(handle.persistQueue, 'enqueueAsync')
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do a long thing', 'task-cancel-1')
      syncSpy.mockClear()
      asyncSpy.mockClear()

      // Await the store directly so the atomic op settles before assertions
      // (cancelTurn fires it as void — the atomicity holds regardless).
      await handle.store.persistTurnCancel(conv)

      const boundaryOps = syncSpy.mock.calls
        .map(call => call[0] as WorkerOp)
        .filter(op => op.kind === 'persist_turn_boundary')
      expect(boundaryOps).toHaveLength(1)
      expect(boundaryOps[0]).toMatchObject({ state: 'idle', activeTaskId: null })

      // No fire-and-forget insert_message / update_session_state pair remains.
      const leakedAsyncOps = asyncSpy.mock.calls
        .map(call => call[1] as WorkerOp)
        .filter(op => op.kind === 'insert_message' || op.kind === 'update_session_state')
      expect(leakedAsyncOps).toHaveLength(0)

      // The session is idle with a cleared active_task_id — never a dirty
      // idle-but-active_task_id state that blocks suspend forever.
      const counts = assistantRowCounts(handle.worker.db, conv.id)
      expect(counts.session).toEqual({ state: 'idle', active_task_id: null })
      await handle.shutdown()
    })
  })

  describe('turn-complete is a single transaction — a torn boundary cannot exist', () => {
    it('a worker failure applies NEITHER the assistant message NOR the active_task_id clear', async () => {
      const raw = createInProcessWorker(tmpDbPath())
      const faulty = new FaultInjectingWorker(raw.worker)
      const queue = new PersistQueue(faulty, { syncTimeoutMs: 2000, asyncTimeoutMs: 5000 })
      const store = new SqliteConversationStore(queue, { cacheSize: 8 })
      const manager = new ConversationManager(store)

      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'question', 'task-torn')

      faulty.armNextBoundaryFailure()
      await expect(manager.completeTurn(conv, 'answer')).rejects.toThrow('simulated fsync failure')

      const counts = assistantRowCounts(raw.db, conv.id)
      // Atomic failure: no assistant row AND active_task_id untouched. The
      // torn states (row without clear / clear without row) are impossible.
      expect(counts.assistantStop).toBe(0)
      expect(counts.session.active_task_id).toBe('task-torn')
      expect(counts.session.state).toBe('processing')
      await queue.close()
    })

    it('a worker failure on turn-start applies NOTHING and rolls back the in-RAM turn', async () => {
      const raw = createInProcessWorker(tmpDbPath())
      const faulty = new FaultInjectingWorker(raw.worker)
      const queue = new PersistQueue(faulty, { syncTimeoutMs: 2000, asyncTimeoutMs: 5000 })
      const store = new SqliteConversationStore(queue, { cacheSize: 8 })
      const manager = new ConversationManager(store)

      const conv = await manager.getOrCreate(SESSION_KEY)
      faulty.armNextBoundaryFailure()
      await expect(manager.startTurn(conv, 'question', 'task-x')).rejects.toThrow(
        'simulated fsync failure'
      )

      const counts = assistantRowCounts(raw.db, conv.id)
      expect(counts.user).toBe(0)
      expect(counts.session.active_task_id).toBeNull()
      // RAM rollback: the conversation is NOT poisoned in Processing — the
      // retry can start a fresh turn.
      expect(conv.state).toBe('idle')
      expect(conv.turns).toHaveLength(0)

      const turn = await manager.startTurn(conv, 'question', 'task-x-retry')
      expect(turn.number).toBe(1)
      await manager.completeTurn(conv, 'answer')
      const after = assistantRowCounts(raw.db, conv.id)
      expect(after.user).toBe(1)
      expect(after.assistantStop).toBe(1)
      expect(after.session).toEqual({ state: 'idle', active_task_id: null })
      await queue.close()
    })
  })

  describe('exactly-once retry after a crash', () => {
    it('replay from the last persisted user message yields exactly ONE completed turn', async () => {
      const dbPath = tmpDbPath()

      // Pod A — turn starts (user message durable via the barrier), then the
      // pod dies before the turn completes.
      const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
      const managerA = new ConversationManager(podA.store)
      const convA = await managerA.getOrCreate(SESSION_KEY)
      await managerA.startTurn(convA, 'compute the report', 'task-crash')
      podA.worker.crash()

      // Pod B — boot reaper clears the dead in-flight task, then the retry
      // replays the same user input as a fresh turn.
      const podB = makeSqliteStore({ dbPath, cacheSize: 4 })
      const reaped = await podB.store.reapProcessingSessions(Date.now())
      expect(reaped).toHaveLength(1)
      expect(reaped[0].activeTaskId).toBe('task-crash')

      const managerB = new ConversationManager(podB.store)
      const convB = await managerB.getOrCreate(SESSION_KEY)
      expect(convB.state).toBe('idle')
      await managerB.startTurn(convB, 'compute the report', 'task-retry')
      await managerB.completeTurn(convB, 'the report')

      // Row counts, not presence: exactly ONE completed turn.
      const counts = assistantRowCounts(podB.worker.db, convB.id)
      expect(counts.assistantStop).toBe(1)
      // Two durable user messages: the crashed attempt (replay anchor) and the
      // retry. The reaper's synthetic interruption row is finish_reason='error'.
      expect(counts.user).toBe(2)
      const errorRows = podB.worker.db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND finish_reason = 'error'"
        )
        .get(convB.id) as { n: number }
      expect(errorRows.n).toBe(1)
      expect(counts.session).toEqual({ state: 'idle', active_task_id: null })
      await podB.shutdown()
    })
  })

  describe('worker exit propagates to a failed turn', () => {
    it('pending boundary ops reject loudly when the worker dies mid-flight', async () => {
      const handle = makeSqliteStore({ dbPath: tmpDbPath() })
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'question', 'task-exit')

      // Kill the worker, then attempt the turn-complete barrier: the closed
      // queue MUST reject (fail the turn), never resolve.
      handle.worker.crash()
      await expect(manager.completeTurn(conv, 'answer')).rejects.toThrow()
    })
  })

  describe('§15 node-loss — power-loss / fsync-fault survival (single-node)', () => {
    it('an ACKed turn survives a simulated power loss + replay exactly once', async () => {
      const dbPath = tmpDbPath()

      // Pod A — complete a turn under the FULL barrier. completeTurn() only
      // resolves after the worker ACKs the durable (fsynced) commit, so the
      // (user, assistant, cleared active_task_id) triple is on disk.
      const podA = makeSqliteStore({ dbPath, barrierMode: true })
      const managerA = new ConversationManager(podA.store)
      const convA = await managerA.getOrCreate(SESSION_KEY)
      await managerA.startTurn(convA, 'compute the report', 'task-ackd')
      await managerA.completeTurn(convA, 'here is the report')

      // Simulate power loss: kill the process WITHOUT a graceful shutdown/drain.
      // Under synchronous=FULL the fsynced WAL commit is already durable.
      podA.worker.crash()

      // Pod B — reopen the SAME on-disk DB and read straight from storage.
      const podB = makeSqliteStore({ dbPath, barrierMode: true })
      const counts = assistantRowCounts(podB.worker.db, convA.id)
      // The ACKed turn is present EXACTLY ONCE and fully settled.
      expect(counts.user).toBe(1)
      expect(counts.assistantStop).toBe(1)
      expect(counts.session).toEqual({ state: 'idle', active_task_id: null })
      // A clean session needs no reaping — nothing was left in-flight.
      const reaped = await podB.store.reapProcessingSessions(Date.now())
      expect(reaped).toHaveLength(0)
      await podB.shutdown()
    })

    it('a turn whose ACK never returned leaves NO half-committed row and replays exactly-once', async () => {
      const dbPath = tmpDbPath()
      const raw = createInProcessWorker(dbPath, { barrierMode: true })
      const faulty = new FaultInjectingWorker(raw.worker)
      const queue = new PersistQueue(faulty, { syncTimeoutMs: 500, asyncTimeoutMs: 5000 })
      const store = new SqliteConversationStore(queue, { cacheSize: 8 })
      const manager = new ConversationManager(store)

      const conv = await manager.getOrCreate(SESSION_KEY)
      // The turn-start boundary commits durably, but its ACK is dropped: the
      // caller times out (process treated as dead) while the write is on disk.
      faulty.dropNextBoundaryAckAfterCommit()
      await expect(manager.startTurn(conv, 'compute the report', 'task-noack')).rejects.toThrow()
      // Power loss: kill without draining.
      raw.crash()

      // Reopen the same DB. The boundary was atomic: the user message + the
      // active_task_id landed TOGETHER (no torn half-commit). The session is
      // legitimately in-flight and the reaper clears it for exactly-once replay.
      const podB = makeSqliteStore({ dbPath, barrierMode: true })
      const before = assistantRowCounts(podB.worker.db, conv.id)
      expect(before.user).toBe(1)
      expect(before.assistantStop).toBe(0)
      expect(before.session).toEqual({ state: 'processing', active_task_id: 'task-noack' })

      const reaped = await podB.store.reapProcessingSessions(Date.now())
      expect(reaped).toHaveLength(1)
      expect(reaped[0].activeTaskId).toBe('task-noack')

      // Replay the same input as a fresh turn — exactly ONE completed turn.
      const managerB = new ConversationManager(podB.store)
      const convB = await managerB.getOrCreate(SESSION_KEY)
      await managerB.startTurn(convB, 'compute the report', 'task-retry')
      await managerB.completeTurn(convB, 'here is the report')

      const after = assistantRowCounts(podB.worker.db, convB.id)
      expect(after.assistantStop).toBe(1)
      // Two durable user rows: the un-acked attempt (replay anchor) + the retry.
      expect(after.user).toBe(2)
      expect(after.session).toEqual({ state: 'idle', active_task_id: null })
      await podB.shutdown()
    })
  })

  describe('micro-bench — synchronous=FULL vs NORMAL (informational)', () => {
    it('reports ms/turn for both pragma levels', async () => {
      const run = async (barrierMode: boolean): Promise<number> => {
        const handle = makeSqliteStore({ dbPath: tmpDbPath(), barrierMode })
        const manager = new ConversationManager(handle.store)
        const conv = await manager.getOrCreate(`bench-${barrierMode}:rpc:agent:default`)
        const turns = 50
        const t0 = performance.now()
        for (let i = 0; i < turns; i++) {
          await manager.startTurn(conv, `question ${i}`, `task-${i}`)
          await manager.completeTurn(conv, `answer ${i}`)
        }
        const elapsed = performance.now() - t0
        await handle.shutdown()
        return elapsed / turns
      }
      const normalMsPerTurn = await run(false)
      const fullMsPerTurn = await run(true)
      console.log(
        `[D3 bench] ms/turn (2 boundary commits each): ` +
          `synchronous=NORMAL ${normalMsPerTurn.toFixed(3)} ms — ` +
          `synchronous=FULL ${fullMsPerTurn.toFixed(3)} ms`
      )
      expect(normalMsPerTurn).toBeGreaterThan(0)
      expect(fullMsPerTurn).toBeGreaterThan(0)
    }, 30000)
  })
})
