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
const SESSIONS = 15_000
const MESSAGES_PER_SESSION = 20
const STALL_TIMEOUT_MS = 1000

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
}, 120_000)

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('sweepRetention on the real DB worker', () => {
  it('sweeps a backlog longer than the progress bound without a stall', async () => {
    const worker = new Worker(workerScript, {
      workerData: { dbPath, checkpointEveryWrites: 100, heartbeatMs: 60_000 },
    })
    const failures: Error[] = []
    const queue = new PersistQueue(worker, {
      syncTimeoutMs: 900,
      asyncTimeoutMs: 900,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      onFailure: err => failures.push(err),
    })
    try {
      await queue.awaitOpen()
      const service = new SessionSearchService({ persistQueue: queue })
      const enqueueSync = vi.spyOn(queue, 'enqueueSync')

      const startedAt = Date.now()
      const deleted = await service.sweepRetention(90)
      const elapsedMs = Date.now() - startedAt

      expect(failures).toEqual([])
      expect(deleted).toBe(SESSIONS)
      // Witnesses that the bound was exercised: the whole sweep took longer
      // than one stall window, and it was split into many operations.
      expect(elapsedMs).toBeGreaterThan(STALL_TIMEOUT_MS)
      expect(enqueueSync.mock.calls.length).toBeGreaterThan(1)
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
  }, 120_000)
})
