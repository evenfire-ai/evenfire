/** SQLite and the dedicated writer fence live in the same worker. */
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import {
  type CanonicalStoreRuntimeOptions,
  assertCanonicalRuntimeConfig,
  assertUncoordinatedStoreBootAllowed,
  requiresExistingStore,
} from '../../canonicalStoreBootGuard'
import { logger } from '../../logger'
import {
  assertLegacyLayoutAllowed,
  assertNoIncompleteCanonicalMigration,
  validateCanonicalStore,
  validateLegacyStore,
} from '../canonicalStore/bootGuard'
import { acquireWriterFence } from '../canonicalStore/writerFence'
import { runMigrations } from '../migrate'
import { applyPragmas } from '../pragmas'
import { createDispatcher, dispatch } from './dispatcher'
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
  barrierMode?: boolean
  canonicalStore?: CanonicalStoreRuntimeOptions
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

async function main(): Promise<void> {
  const port = parentPort
  if (!port) throw new Error('dbWorker must be spawned via worker_threads')
  const data = workerData as WorkerData
  if (!data?.dbPath) throw new Error('dbWorker: dbPath is required')
  const runtime = data.canonicalStore
  if (runtime) assertCanonicalRuntimeConfig('sqlite', data.dbPath, runtime)
  else assertUncoordinatedStoreBootAllowed(data.dbPath)
  // Optional only for old development/test callers. Every HCC-admitted template
  // supplies this contract, including a PVC fence for an external legacy DB.
  const existingRequired = runtime ? requiresExistingStore(runtime) : false
  const fence = runtime
    ? acquireWriterFence({ stateDir: runtime.stateDir, requireExisting: existingRequired })
    : undefined
  let db: Database.Database | undefined
  try {
    fence?.assertHeld()
    if (runtime) {
      assertNoIncompleteCanonicalMigration({ stateDir: runtime.stateDir, root: runtime.legacyRoot })
      if (runtime.required)
        validateCanonicalStore({ stateDir: runtime.stateDir, binding: runtime.binding })
      else if (runtime.storageContract === 'legacy-floor') {
        validateLegacyStore({ stateDir: runtime.stateDir, binding: runtime.binding })
      } else {
        if (runtime.legacyRoot) assertLegacyLayoutAllowed(runtime.legacyRoot, runtime.binding)
        assertUncoordinatedStoreBootAllowed(data.dbPath)
      }
    }
    // Both committed layouts require an existing database and fence; only unadmitted development callers may create.
    if (!existingRequired) fs.mkdirSync(path.dirname(data.dbPath), { recursive: true })
    fence?.assertHeld()
    db = new Database(data.dbPath, { fileMustExist: existingRequired })
    const pragmaResult = applyPragmas(db, {
      barrierMode: data.barrierMode === true || existingRequired,
    })
    if (!pragmaResult.walAvailable)
      port.postMessage({
        id: '__warn__',
        ok: true,
        result: { kind: 'wal_unavailable', journalMode: pragmaResult.journalMode },
      } satisfies WorkerReply)
    fence?.assertHeld()
    runMigrations(db)
    const database = db
    const deps = createDispatcher(database, fence ? () => fence.assertHeld() : undefined)
    const checkpointEvery = Math.max(1, data.checkpointEveryWrites ?? 100)
    let writesSinceCheckpoint = 0
    let stopped = false
    let serial: Promise<void> = Promise.resolve()
    const release = () => {
      stopped = true
      // Release coordination only after all SQLite handles have closed.
      try {
        if (database.open) database.close()
      } finally {
        fence?.close()
      }
    }
    const fatal = (error: unknown) => {
      release()
      port.postMessage({
        id: '__fatal__',
        ok: false,
        error: { code: 'WRITER_FENCE_LOST', message: 'ConversationStoreWriterStopped' },
      } satisfies WorkerReply)
      logger.error({ err: error }, '[dbWorker] writer stopped after fence loss')
      process.exit(1)
    }
    port.on('message', (msg: WorkerMessage) => {
      // FIFO includes retries, checkpoints and shutdown. No late write can run
      // after the shutdown acknowledgment has released the fence.
      serial = serial
        .then(async () => {
          if (stopped) return
          try {
            fence?.assertHeld()
            if (msg.op.kind === 'shutdown') {
              release()
              port.postMessage({
                id: msg.id,
                ok: true,
                result: { ok: true, closed: true },
              } satisfies WorkerReply)
              port.close()
              return
            }
            const result = await dispatch(msg.op, deps)
            fence?.assertHeld()
            if (isWriteOp(msg.op)) {
              writesSinceCheckpoint++
              if (writesSinceCheckpoint >= checkpointEvery) {
                fence?.assertHeld()
                try {
                  database.pragma('wal_checkpoint(PASSIVE)')
                } catch (err) {
                  logger.warn({ err }, '[dbWorker] PASSIVE checkpoint failed')
                }
                writesSinceCheckpoint = 0
              }
            }
            port.postMessage({ id: msg.id, ok: true, result } satisfies WorkerReply)
          } catch (error) {
            try {
              fence?.assertHeld()
            } catch {
              fatal(error)
              return
            }
            const e = error as { code?: string; message?: string }
            port.postMessage({
              id: msg.id,
              ok: false,
              error: {
                code: e.code ?? 'WORKER_ERROR',
                message: e.message ?? 'ConversationStoreOperationFailed',
              },
            } satisfies WorkerReply)
          }
        })
        .catch(fatal)
    })
    const heartbeatTimer = setInterval(
      () => {
        if (stopped) return
        try {
          fence?.assertHeld()
        } catch (error) {
          fatal(error)
          return
        }
        const payload: HeartbeatPayload = {
          kind: 'heartbeat',
          writesSinceCheckpoint,
          dbBytes: fileSize(data.dbPath),
          walBytes: fileSize(`${data.dbPath}-wal`),
        }
        port.postMessage({
          id: HEARTBEAT_ID,
          ok: true,
          result: payload,
        } satisfies WorkerReply<HeartbeatPayload>)
      },
      Math.max(1000, data.heartbeatMs ?? 5000)
    )
    heartbeatTimer.unref()
  } catch (error) {
    try {
      if (db?.open) db.close()
    } finally {
      fence?.close()
    }
    throw error
  }
}
main().catch(error => {
  parentPort?.postMessage({
    id: '__fatal__',
    ok: false,
    error: {
      code: 'WORKER_FATAL',
      message: error instanceof Error ? error.message : 'ConversationStoreBootFailed',
    },
  } satisfies WorkerReply)
  process.exit(1)
})
