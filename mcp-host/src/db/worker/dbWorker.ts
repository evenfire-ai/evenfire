/**
 * SQLite worker thread entry. Spawned by `main.ts` (or by tests via
 * `new Worker(require.resolve('...'))`). The main thread sends `WorkerMessage`
 * over `MessagePort.postMessage` and receives `WorkerReply` back.
 *
 * Why a dedicated worker: `better-sqlite3` is sync, so any 5–20 ms write
 * blocks the event loop. Pushing all DB work into a worker keeps the main
 * thread responsive for HTTP/SSE/timers.
 */
import * as fs from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { logger } from '../../logger'
import { runMigrations } from '../migrate'
import { applyPragmas } from '../pragmas'
import { createDispatcher, dispatch } from './dispatcher'
import { openConversationDatabase } from './openDatabase'
import {
  HEARTBEAT_ID,
  type HeartbeatPayload,
  type WorkerMessage,
  type WorkerReply,
  isWriteOp,
} from './protocol'

interface WorkerData {
  dbPath: string
  checkpointEveryWrites?: number
  heartbeatMs?: number
  /** D3 — durability barrier: apply `PRAGMA synchronous = FULL` (see pragmas.ts). */
  barrierMode?: boolean
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('dbWorker.ts must be spawned via worker_threads')
  }
  const data = workerData as WorkerData
  if (!data?.dbPath) {
    throw new Error('dbWorker.ts: workerData.dbPath is required')
  }

  const db = openConversationDatabase(data.dbPath)
  const pragmaResult = applyPragmas(db, { barrierMode: data.barrierMode === true })
  if (!pragmaResult.walAvailable) {
    parentPort.postMessage({
      id: '__warn__',
      ok: true,
      result: {
        kind: 'wal_unavailable',
        journalMode: pragmaResult.journalMode,
      },
    } satisfies WorkerReply)
  }

  runMigrations(db)
  const deps = createDispatcher(db)
  const checkpointEvery = Math.max(1, data.checkpointEveryWrites ?? 100)
  let writesSinceCheckpoint = 0

  parentPort.on('message', async (msg: WorkerMessage) => {
    if (!parentPort) return
    try {
      const result = await dispatch(msg.op, deps)
      if (isWriteOp(msg.op)) {
        writesSinceCheckpoint += 1
        if (writesSinceCheckpoint >= checkpointEvery) {
          try {
            db.pragma('wal_checkpoint(PASSIVE)')
          } catch (err) {
            logger.warn({ err }, '[dbWorker] PASSIVE checkpoint failed')
          }
          writesSinceCheckpoint = 0
        }
      }
      if (msg.op.kind === 'shutdown') {
        // Close (and checkpoint) before the ACK: the main thread terminates
        // the worker as soon as it sees the reply.
        db.close()
        parentPort.postMessage({ id: msg.id, ok: true, result } satisfies WorkerReply)
        process.exit(0)
      }
      const reply: WorkerReply = { id: msg.id, ok: true, result }
      parentPort.postMessage(reply)
    } catch (err) {
      const e = err as { code?: string; message?: string; stack?: string }
      const reply: WorkerReply = {
        id: msg.id,
        ok: false,
        error: {
          code: e.code ?? 'WORKER_ERROR',
          message: e.message ?? String(err),
          stack: e.stack,
        },
      }
      parentPort.postMessage(reply)
    }
  })

  const heartbeatMs = Math.max(1000, data.heartbeatMs ?? 5000)
  const heartbeatTimer = setInterval(() => {
    if (!parentPort) return
    const payload: HeartbeatPayload = {
      kind: 'heartbeat',
      writesSinceCheckpoint,
      dbBytes: fileSize(data.dbPath),
      walBytes: fileSize(`${data.dbPath}-wal`),
    }
    const reply: WorkerReply<HeartbeatPayload> = {
      id: HEARTBEAT_ID,
      ok: true,
      result: payload,
    }
    parentPort.postMessage(reply)
  }, heartbeatMs)
  heartbeatTimer.unref()
}

main().catch(err => {
  // The main thread does not read `__fatal__`; this line is the only record
  // of why the worker stopped (for example an orphan-WAL refusal).
  logger.error({ err }, '[dbWorker] fatal; exiting with code 1')
  if (parentPort) {
    parentPort.postMessage({
      id: '__fatal__',
      ok: false,
      error: { code: 'WORKER_FATAL', message: (err as Error).message },
    } satisfies WorkerReply)
  }
  process.exit(1)
})
