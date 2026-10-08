/**
 * #1043 — durable model-step checkpoint store over the real dispatcher and a
 * file-backed SQLite database (so a cold reopen reads what the disk holds).
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ModelStepCheckpointEntryInput,
  ModelStepCheckpointFence,
  ModelStepCheckpointOpenHeader,
} from '../../../../db/worker/modelStepCheckpointOps'
import type { MessageRow } from '../../../../db/worker/protocol'
import { ConversationManager } from '../../conversation'
import { ModelStepCheckpointStore } from '../modelStepCheckpointStore'
import { PersistQueue } from '../persistQueue'
import { type InProcessWorkerHandle, createInProcessWorker, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-1043:rpc:agent:default'
const ORIGIN_TASK = 'task-origin'
const LEASE_MS = 300_000

let clock = 1_000_000
const tempDirs: string[] = []
const openQueues: PersistQueue[] = []

afterEach(async () => {
  for (const queue of openQueues.splice(0)) await queue.close()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  clock = 1_000_000
})

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-1043-'))
  tempDirs.push(dir)
  return path.join(dir, 'host.db')
}

function storeOver(worker: InProcessWorkerHandle): {
  checkpoints: ModelStepCheckpointStore
  queue: PersistQueue
} {
  const queue = new PersistQueue(worker.worker, { syncTimeoutMs: 2000, asyncTimeoutMs: 5000 })
  openQueues.push(queue)
  return { checkpoints: new ModelStepCheckpointStore(queue, { now: () => clock }), queue }
}

function header(checkpointId = 'cp-1', sessionKey = SESSION_KEY): ModelStepCheckpointOpenHeader {
  return {
    checkpointId,
    sessionKey,
    originTurnNumber: 3,
    originTaskId: ORIGIN_TASK,
    provider: 'codex-subscription',
    model: 'gpt-5.5',
    hostId: 'host-a',
    principal: 'user-1043',
    loopState: JSON.stringify({ iteration: 0 }),
    taskBudget: null,
  }
}

const userEntry: ModelStepCheckpointEntryInput = {
  kind: 'message',
  toolCallId: null,
  payload: JSON.stringify({ role: 'user', content: 'list the files' }),
}
const dispatch = (id: string): ModelStepCheckpointEntryInput => ({
  kind: 'tool_dispatch',
  toolCallId: id,
  payload: JSON.stringify({ name: 'list_files' }),
})
const result = (id: string): ModelStepCheckpointEntryInput => ({
  kind: 'tool_result',
  toolCallId: id,
  payload: JSON.stringify({ name: 'list_files', isError: false }),
})

async function openResumable(
  checkpoints: ModelStepCheckpointStore,
  checkpointId = 'cp-1',
  sessionKey = SESSION_KEY
): Promise<{ fence: ModelStepCheckpointFence; version: number }> {
  const fence = await checkpoints.open(header(checkpointId, sessionKey), [userEntry])
  expect(await checkpoints.append(sessionKey, fence, [dispatch('tc-1'), result('tc-1')])).toBe(true)
  const version = await checkpoints.transition(sessionKey, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: clock,
    expiresAt: clock + 7 * 24 * 3_600_000,
  })
  expect(version).toBe(2)
  return { fence, version: version as number }
}

function statusOf(worker: InProcessWorkerHandle, checkpointId: string): string | undefined {
  const row = worker.db
    .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
    .get(checkpointId) as { status: string } | undefined
  return row?.status
}

describe('ModelStepCheckpointStore (#1043)', () => {
  it('1. entries round-trip and a cold reopen reads the same view', async () => {
    const dbPath = tempDbPath()
    const first = createInProcessWorker(dbPath)
    const { checkpoints, queue } = storeOver(first)
    const fence = await checkpoints.open(header(), [userEntry])
    await checkpoints.append(SESSION_KEY, fence, [
      dispatch('tc-1'),
      result('tc-1'),
      dispatch('tc-2'),
    ])
    await checkpoints.transition(SESSION_KEY, fence, {
      from: ['open'],
      to: 'resumable',
      failedAt: clock,
      expiresAt: clock + 1000,
    })
    const before = await checkpoints.loadLive(SESSION_KEY)
    const entriesBefore = await checkpoints.loadEntries(SESSION_KEY, 'cp-1')
    await queue.close()
    first.terminate()

    const reopened = createInProcessWorker(dbPath)
    const cold = storeOver(reopened).checkpoints
    const after = await cold.loadLive(SESSION_KEY)
    expect(after).toEqual(before)
    expect(after?.header).toMatchObject({ status: 'resumable', version: 2, claim_generation: 0 })
    expect(after?.tools).toEqual({ confirmed: 1, unknown: 1, notDispatched: 0 })
    const entriesAfter = await cold.loadEntries(SESSION_KEY, 'cp-1')
    expect(entriesAfter).toEqual(entriesBefore)
    expect(entriesAfter.map(e => [e.seq, e.kind, e.tool_call_id])).toEqual([
      [1, 'message', null],
      [2, 'tool_dispatch', 'tc-1'],
      [3, 'tool_result', 'tc-1'],
      [4, 'tool_dispatch', 'tc-2'],
    ])
    reopened.terminate()
  })

  it('2. at most one non-terminal checkpoint per session', async () => {
    const worker = createInProcessWorker(tempDbPath())
    const { checkpoints } = storeOver(worker)
    await checkpoints.open(header('cp-1'), [userEntry])
    await expect(checkpoints.open(header('cp-2'), [userEntry])).rejects.toThrow(/UNIQUE/)
    expect((await checkpoints.loadLive(SESSION_KEY))?.header.checkpoint_id).toBe('cp-1')
    expect(statusOf(worker, 'cp-2')).toBeUndefined()
    // Another session is unaffected by the index.
    await checkpoints.open(header('cp-3', 'user-1043:rpc:agent:other'), [userEntry])
    expect(statusOf(worker, 'cp-3')).toBe('open')
  })

  it('3. two concurrent claims of the same version: one winner, the loser replays it', async () => {
    const worker = createInProcessWorker(tempDbPath())
    const { checkpoints } = storeOver(worker)
    const { version } = await openResumable(checkpoints)
    const claim = (newTaskId: string) =>
      checkpoints.claim({
        sessionKey: SESSION_KEY,
        checkpointId: 'cp-1',
        version,
        hostInstanceId: 'host-instance-a',
        newTaskId,
        leaseMs: LEASE_MS,
      })
    const outcomes = await Promise.all([claim('task-cont-1'), claim('task-cont-2')])
    const winner = outcomes.find(o => o.outcome === 'claimed')
    const loser = outcomes.find(o => o.outcome === 'replayed')
    expect(winner).toMatchObject({ outcome: 'claimed', taskId: 'task-cont-1', reclaimed: false })
    expect(loser).toEqual({ outcome: 'replayed', taskId: 'task-cont-1' })
    const claimedRows = worker.db
      .prepare("SELECT COUNT(*) AS n FROM model_step_checkpoints WHERE status = 'claimed'")
      .get() as { n: number }
    expect(claimedRows.n).toBe(1)
  })

  it('3b. status comes first: a stale version on a resumable row is a mismatch with the current view', async () => {
    const worker = createInProcessWorker(tempDbPath())
    const { checkpoints } = storeOver(worker)
    await openResumable(checkpoints)
    const outcome = await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-1',
      version: 1,
      hostInstanceId: 'host-instance-a',
      newTaskId: 'task-cont-1',
      leaseMs: LEASE_MS,
    })
    expect(outcome).toMatchObject({
      outcome: 'version_mismatch',
      current: { header: { status: 'resumable', version: 2 } },
    })
    expect(statusOf(worker, 'cp-1')).toBe('resumable')
    // Wrong session and unknown id are both not_found.
    const foreign = await checkpoints.claim({
      sessionKey: 'user-1043:rpc:agent:other',
      checkpointId: 'cp-1',
      version: 2,
      hostInstanceId: 'host-instance-a',
      newTaskId: 'task-x',
      leaseMs: LEASE_MS,
    })
    expect(foreign).toEqual({ outcome: 'not_found' })
  })

  it('4. an expired lease is re-claimed: same checkpoint and entries, a new task id, one claimed row', async () => {
    const worker = createInProcessWorker(tempDbPath())
    const { checkpoints } = storeOver(worker)
    const { version } = await openResumable(checkpoints)
    const first = await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-1',
      version,
      hostInstanceId: 'host-instance-a',
      newTaskId: 'task-cont-1',
      leaseMs: LEASE_MS,
    })
    expect(first).toMatchObject({ outcome: 'claimed', fence: { generation: 1 } })
    const entriesBefore = await checkpoints.loadEntries(SESSION_KEY, 'cp-1')

    clock += LEASE_MS + 1
    const second = await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-1',
      version: 999,
      hostInstanceId: 'host-instance-b',
      newTaskId: 'task-cont-2',
      leaseMs: LEASE_MS,
    })
    expect(second).toMatchObject({
      outcome: 'claimed',
      taskId: 'task-cont-2',
      reclaimed: true,
      fence: { checkpointId: 'cp-1', owner: 'host-instance-b', generation: 2 },
    })
    expect(await checkpoints.loadEntries(SESSION_KEY, 'cp-1')).toEqual(entriesBefore)
    const rows = worker.db
      .prepare('SELECT checkpoint_id, status, continuation_task_id FROM model_step_checkpoints')
      .all()
    expect(rows).toEqual([
      { checkpoint_id: 'cp-1', status: 'claimed', continuation_task_id: 'task-cont-2' },
    ])
  })

  it('4b. boot reap: a claim held by another host instance becomes resumable, an open row is abandoned', async () => {
    const worker = createInProcessWorker(tempDbPath())
    const { checkpoints } = storeOver(worker)
    const { version } = await openResumable(checkpoints, 'cp-foreign')
    await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-foreign',
      version,
      hostInstanceId: 'host-instance-old',
      newTaskId: 'task-cont-1',
      leaseMs: LEASE_MS,
    })
    const ownKey = 'user-1043:rpc:agent:own'
    const own = await openResumable(checkpoints, 'cp-own', ownKey)
    await checkpoints.claim({
      sessionKey: ownKey,
      checkpointId: 'cp-own',
      version: own.version,
      hostInstanceId: 'host-instance-new',
      newTaskId: 'task-cont-own',
      leaseMs: LEASE_MS,
    })
    await checkpoints.open(header('cp-open', 'user-1043:rpc:agent:open'), [userEntry])

    const reaped = await checkpoints.bootReap('host-instance-new')
    expect(reaped).toEqual({ abandoned: 1, reopened: 1 })
    expect((await checkpoints.loadLive(SESSION_KEY))?.header).toMatchObject({
      checkpoint_id: 'cp-foreign',
      status: 'resumable',
      version: version + 2,
      claim_expires_at: null,
    })
    expect(statusOf(worker, 'cp-open')).toBe('abandoned')
    expect(statusOf(worker, 'cp-own')).toBe('claimed')
  })

  it('4c. a new turn retires the previous resumable checkpoint in its own transaction', async () => {
    const handle = makeSqliteStore({ dbPath: tempDbPath() })
    openQueues.push(handle.persistQueue)
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, { now: () => clock })
    const manager = new ConversationManager(handle.store)
    const conv = await manager.getOrCreate(SESSION_KEY)
    await manager.startTurn(conv, 'first turn', 'task-1')
    await openResumable(checkpoints, 'cp-previous')
    await manager.failTurn(conv)

    await manager.startTurn(conv, 'a new message', 'task-2')
    expect(statusOf(handle.worker, 'cp-previous')).toBe('abandoned')
    await checkpoints.open(header('cp-next'), [userEntry])

    const rows = handle.worker.db
      .prepare('SELECT checkpoint_id, status FROM model_step_checkpoints ORDER BY checkpoint_id')
      .all()
    expect(rows).toEqual([
      { checkpoint_id: 'cp-next', status: 'open' },
      { checkpoint_id: 'cp-previous', status: 'abandoned' },
    ])
    const userRow = handle.worker.db
      .prepare(
        "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY ordinal DESC"
      )
      .get(conv.id) as { content: string }
    expect(userRow.content).toBe('a new message')
  })

  describe('4e. fence after a re-claim', () => {
    async function reclaimed() {
      const handle = makeSqliteStore({ dbPath: tempDbPath() })
      openQueues.push(handle.persistQueue)
      const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, { now: () => clock })
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'turn', 'task-1')
      const { version } = await openResumable(checkpoints)
      const stale = await checkpoints.claim({
        sessionKey: SESSION_KEY,
        checkpointId: 'cp-1',
        version,
        hostInstanceId: 'host-instance-a',
        newTaskId: 'task-cont-1',
        leaseMs: LEASE_MS,
      })
      clock += LEASE_MS + 1
      const fresh = await checkpoints.claim({
        sessionKey: SESSION_KEY,
        checkpointId: 'cp-1',
        version,
        hostInstanceId: 'host-instance-a',
        newTaskId: 'task-cont-2',
        leaseMs: LEASE_MS,
      })
      if (stale.outcome !== 'claimed' || fresh.outcome !== 'claimed') {
        throw new Error(`expected two claims, got ${stale.outcome} / ${fresh.outcome}`)
      }
      return { handle, checkpoints, conv, staleFence: stale.fence, freshFence: fresh.fence }
    }

    function finalMessage(sessionId: string, ordinal: number): MessageRow {
      return {
        session_id: sessionId,
        ordinal,
        role: 'assistant',
        content: 'final answer',
        content_parts: null,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: clock / 1000,
        token_count: null,
        finish_reason: 'stop',
        spillover_ref: null,
        is_error: 0,
        turn_number: 1,
      }
    }

    it('the superseded owner cannot append, renew or complete; the new owner can', async () => {
      const { handle, checkpoints, conv, staleFence, freshFence } = await reclaimed()
      expect(staleFence.generation).toBe(1)
      expect(freshFence.generation).toBe(2)

      expect(await checkpoints.append(SESSION_KEY, staleFence, [dispatch('tc-stale')])).toBe(false)
      expect(await checkpoints.renewLease(SESSION_KEY, staleFence, LEASE_MS)).toBe(false)
      expect(
        await checkpoints.transition(SESSION_KEY, staleFence, {
          from: ['claimed'],
          to: 'completed',
        })
      ).toBeNull()
      await expect(
        handle.persistQueue.enqueueSync(
          {
            kind: 'persist_turn_boundary',
            message: finalMessage(conv.id, 900),
            sessionId: conv.id,
            state: 'idle',
            activeTaskId: null,
            completeModelStepCheckpoint: staleFence,
          },
          SESSION_KEY
        )
      ).rejects.toThrow(/fence mismatch/)
      const staleMessage = handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND ordinal = 900')
        .get(conv.id) as { n: number }
      expect(staleMessage.n).toBe(0)

      // Witness: the live owner's writes land.
      expect(await checkpoints.append(SESSION_KEY, freshFence, [dispatch('tc-fresh')])).toBe(true)
      expect(await checkpoints.renewLease(SESSION_KEY, freshFence, LEASE_MS)).toBe(true)
      const toolIds = (await checkpoints.loadEntries(SESSION_KEY, 'cp-1'))
        .filter(e => e.kind === 'tool_dispatch')
        .map(e => e.tool_call_id)
      expect(toolIds).toEqual(['tc-1', 'tc-fresh'])

      await handle.persistQueue.enqueueSync(
        {
          kind: 'persist_turn_boundary',
          message: finalMessage(conv.id, 901),
          sessionId: conv.id,
          state: 'idle',
          activeTaskId: null,
          completeModelStepCheckpoint: freshFence,
        },
        SESSION_KEY
      )
      const stamped = handle.worker.db
        .prepare(
          'SELECT model_step_checkpoint_id FROM messages WHERE session_id = ? AND ordinal = 901'
        )
        .get(conv.id) as { model_step_checkpoint_id: string }
      expect(stamped.model_step_checkpoint_id).toBe('cp-1')
      expect(statusOf(handle.worker, 'cp-1')).toBe('completed')
      expect(
        await checkpoints.claim({
          sessionKey: SESSION_KEY,
          checkpointId: 'cp-1',
          version: 1,
          hostInstanceId: 'host-instance-a',
          newTaskId: 'task-cont-3',
          leaseMs: LEASE_MS,
        })
      ).toEqual({ outcome: 'completed', taskId: 'task-cont-2' })
    })
  })

  describe('5. crash at three points, then reopen and boot reap', () => {
    async function crashAfter(entries: ModelStepCheckpointEntryInput[]) {
      const dbPath = tempDbPath()
      const first = createInProcessWorker(dbPath)
      const { checkpoints } = storeOver(first)
      const fence = await checkpoints.open(header(), [userEntry])
      if (entries.length > 0) await checkpoints.append(SESSION_KEY, fence, entries)
      first.crash()

      const reopened = createInProcessWorker(dbPath)
      const cold = storeOver(reopened).checkpoints
      const live = await cold.loadLive(SESSION_KEY)
      const reaped = await cold.bootReap('host-instance-after-crash')
      return { live, reaped, status: statusOf(reopened, 'cp-1'), reopened }
    }

    it('before tool_dispatch: open is abandoned, no tool recorded', async () => {
      const { live, reaped, status, reopened } = await crashAfter([])
      expect(live?.tools).toEqual({ confirmed: 0, unknown: 0, notDispatched: 0 })
      expect(reaped).toEqual({ abandoned: 1, reopened: 0 })
      expect(status).toBe('abandoned')
      reopened.terminate()
    })

    it('after tool_result: the tool reads confirmed, open is abandoned', async () => {
      const { live, reaped, status, reopened } = await crashAfter([
        dispatch('tc-1'),
        result('tc-1'),
      ])
      expect(live?.tools).toEqual({ confirmed: 1, unknown: 0, notDispatched: 0 })
      expect(reaped).toEqual({ abandoned: 1, reopened: 0 })
      expect(status).toBe('abandoned')
      reopened.terminate()
    })

    it('between the effect and tool_result: the tool reads unknown', async () => {
      const { live, reaped, status, reopened } = await crashAfter([dispatch('tc-1')])
      expect(live?.tools).toEqual({ confirmed: 0, unknown: 1, notDispatched: 0 })
      expect(reaped).toEqual({ abandoned: 1, reopened: 0 })
      expect(status).toBe('abandoned')
      reopened.terminate()
    })
  })

  it('6. TTL: expired rows are abandoned, terminal entries are purged after retention', async () => {
    const worker = createInProcessWorker(tempDbPath())
    const { checkpoints } = storeOver(worker)
    const fence = await checkpoints.open(header(), [userEntry])
    await checkpoints.append(SESSION_KEY, fence, [dispatch('tc-1'), result('tc-1')])
    await checkpoints.transition(SESSION_KEY, fence, {
      from: ['open'],
      to: 'resumable',
      failedAt: clock,
      expiresAt: clock + 100,
    })
    const retention = 1000

    clock += 50
    expect(await checkpoints.sweep(retention)).toEqual({ expired: 0, purgedEntries: 0 })
    expect(statusOf(worker, 'cp-1')).toBe('resumable')

    clock += 100
    expect(await checkpoints.sweep(retention)).toEqual({ expired: 1, purgedEntries: 0 })
    expect(statusOf(worker, 'cp-1')).toBe('abandoned')
    expect(await checkpoints.loadEntries(SESSION_KEY, 'cp-1')).toHaveLength(3)

    clock += retention
    expect(await checkpoints.sweep(retention)).toEqual({ expired: 0, purgedEntries: 3 })
    expect(await checkpoints.loadEntries(SESSION_KEY, 'cp-1')).toHaveLength(0)
  })

  it('6b. TTL keeps a claimed row whose lease is alive, and expires it once the lease lapses', async () => {
    const worker = createInProcessWorker(tempDbPath())
    const { checkpoints } = storeOver(worker)
    const fence = await checkpoints.open(header(), [userEntry])
    const version = await checkpoints.transition(SESSION_KEY, fence, {
      from: ['open'],
      to: 'resumable',
      failedAt: clock,
      expiresAt: clock + 100,
    })
    await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-1',
      version: version as number,
      hostInstanceId: 'host-instance-a',
      newTaskId: 'task-cont-1',
      leaseMs: 500,
    })
    clock += 200
    expect(await checkpoints.sweep(1000)).toEqual({ expired: 0, purgedEntries: 0 })
    expect(statusOf(worker, 'cp-1')).toBe('claimed')
    clock += 400
    expect(await checkpoints.sweep(1000)).toEqual({ expired: 1, purgedEntries: 0 })
    expect(statusOf(worker, 'cp-1')).toBe('abandoned')
  })
})
