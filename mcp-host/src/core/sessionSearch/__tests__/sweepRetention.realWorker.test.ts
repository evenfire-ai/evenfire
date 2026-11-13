import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { runMigrations } from '../../../db/migrate'
import { applyPragmas } from '../../../db/pragmas'
import { MCP_HOST_ROOT, compileSources } from '../../../db/worker/__tests__/compileSources'
import { PersistQueue } from '../../conversation/persistence/persistQueue'
import { SessionSearchService } from '../service'

// A retention backlog whose single DELETE outlasts the progress bound used to
// latch the queue (`db worker made no progress`), end the Host with exit 1
// and repeat on every restart. The sweep runs on the real worker thread here,
// so the bound is measured against real SQLite cascade and FTS work.
//
// The bound is compared with the CPU time the worker thread spends on each
// operation, not with wall time. Wall time also counts waiting (for a core,
// for the disk, for the checkpoint) and the main thread reading the reply
// late, so on a busy machine a batch of a few milliseconds of work can take
// longer than the bound. The queue's own wall-clock limits are
// therefore set far above anything a batch needs, and only stop a wedged
// worker from hanging the test.
const SESSIONS = 15_000
const MESSAGES_PER_SESSION = 20
/** The smallest value `CLERUM_DB_WORKER_STALL_TIMEOUT_MS` accepts. */
const PROGRESS_BOUND_MS = 1000
/** Largest share of the sweep's worker CPU time one operation may take. */
const MAX_OPERATION_SHARE = 0.1
const WEDGED_WORKER_TIMEOUT_MS = 300_000
const SETUP_AND_TEST_TIMEOUT_MS = 600_000

/**
 * `Worker.cpuUsage()` is present in the Node version the package requires
 * (`engines.node`); the installed `@types/node` major does not declare it.
 */
type CpuUsage = { user: number; system: number }
type WorkerWithCpuUsage = Worker & { cpuUsage(previous?: CpuUsage): Promise<CpuUsage> }

let tmpRoot: string
let workerScript: string
let dbPath: string

function seedBacklog(file: string): void {
  const db = new Database(file)
  try {
    applyPragmas(db)
    runMigrations(db)
    const endedAt = Date.now() / 1000 - 100 * 86400
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, session_key, source, user_id, channel_type, channel_id,
         started_at, ended_at, end_reason, message_count, tool_call_count,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, state)
       VALUES (@id, @id, 'rpc', 'u1', 'rpc', 'agent', @ended_at, @ended_at, 'cancelled',
         0, 0, 0, 0, 0, 0, 'idle')`
    )
    const insertMessage = db.prepare(
      `INSERT INTO messages (session_id, ordinal, role, content, timestamp, is_error, turn_number)
       VALUES (@session_id, @ordinal, 'user', @content, @ended_at, 0, 1)`
    )
    db.transaction(() => {
      for (let s = 0; s < SESSIONS; s++) {
        const id = `expired-${s}`
        insertSession.run({ id, ended_at: endedAt })
        for (let ordinal = 0; ordinal < MESSAGES_PER_SESSION; ordinal++) {
          insertMessage.run({
            session_id: id,
            ordinal,
            content: `backlog message ${s} ${ordinal}`,
            ended_at: endedAt,
          })
        }
      }
    })()
  } finally {
    db.close()
  }
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-real-worker-'))
  fs.symlinkSync(path.join(MCP_HOST_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'))
  ;[workerScript] = compileSources(['db/worker/dbWorker.ts'], path.join(tmpRoot, 'dist'))
  dbPath = path.join(tmpRoot, 'state.db')
  seedBacklog(dbPath)
}, SETUP_AND_TEST_TIMEOUT_MS)

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('sweepRetention on the real DB worker', () => {
  it(
    'sweeps a backlog longer than the progress bound in operations shorter than it',
    async () => {
      const worker = new Worker(workerScript, {
        workerData: { dbPath, checkpointEveryWrites: 100, heartbeatMs: 60_000 },
      }) as WorkerWithCpuUsage
      const failures: Error[] = []
      const queue = new PersistQueue(worker, {
        syncTimeoutMs: WEDGED_WORKER_TIMEOUT_MS,
        asyncTimeoutMs: WEDGED_WORKER_TIMEOUT_MS,
        stallTimeoutMs: WEDGED_WORKER_TIMEOUT_MS,
        onFailure: err => failures.push(err),
      })
      // Worker-thread CPU time of each operation, in milliseconds. The sample
      // is taken before the result goes back to the sweep loop, so the worker
      // is idle and the difference belongs to that one operation.
      const operationCpuMs: number[] = []
      try {
        await queue.awaitOpen()
        const service = new SessionSearchService({ persistQueue: queue })
        const send = queue.enqueueSync.bind(queue)
        let previous = await worker.cpuUsage()
        const enqueueSync = vi.spyOn(queue, 'enqueueSync').mockImplementation(async (op, key) => {
          const result = await send(op, key)
          const current = await worker.cpuUsage()
          operationCpuMs.push(
            (current.user + current.system - previous.user - previous.system) / 1000
          )
          previous = current
          return result as never
        })

        const deleted = await service.sweepRetention(90)

        expect(failures).toEqual([])
        expect(deleted).toBe(SESSIONS)
        // Every operation was measured.
        expect(operationCpuMs).toHaveLength(enqueueSync.mock.calls.length)
        const totalCpuMs = operationCpuMs.reduce((sum, ms) => sum + ms, 0)
        const slowestCpuMs = Math.max(...operationCpuMs)
        // An unbounded batch is one operation that carries most of the sweep,
        // whatever the speed of the machine.
        expect(slowestCpuMs / totalCpuMs).toBeLessThan(MAX_OPERATION_SHARE)
        // Witness that the bound was exercised: the backlog needed more worker
        // CPU time than one progress window, and no operation needed that much.
        expect(totalCpuMs).toBeGreaterThan(PROGRESS_BOUND_MS)
        expect(slowestCpuMs).toBeLessThan(PROGRESS_BOUND_MS)
        // The sweep was split into many operations.
        expect(enqueueSync.mock.calls.length).toBeGreaterThan(1)
        enqueueSync.mockRestore()
        await expect(queue.enqueueSync({ kind: 'ping' })).resolves.toBeDefined()
      } finally {
        await queue.close()
      }

      const reader = new Database(dbPath, { readonly: true })
      try {
        const counts = reader
          .prepare(
            'SELECT (SELECT COUNT(*) FROM sessions) AS s, (SELECT COUNT(*) FROM messages) AS m'
          )
          .get() as { s: number; m: number }
        expect(counts).toEqual({ s: 0, m: 0 })
      } finally {
        reader.close()
      }
    },
    SETUP_AND_TEST_TIMEOUT_MS
  )
})
