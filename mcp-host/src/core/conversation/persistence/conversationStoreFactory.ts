/**
 * Factory + thin lifecycle wrapper around the conversation store and its
 * SQLite worker. Hides the worker spawn / `PersistQueue` plumbing from
 * `main.ts` so the bootstrap stays terse.
 *
 * Modes:
 *   - `memory`: pure RAM (legacy / dev). No worker spawned.
 *   - `sqlite`: SQLite-backed, worker thread spawned.
 *   - `dual`:   both stores live, reads from RAM, writes to both (canary).
 */
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import { logger } from '../../../logger'
import { type ConversationStore, InMemoryConversationStore } from '../conversationStore'
import { DualConversationStore } from './dualConversationStore'
import { PersistQueue, type WorkerLike } from './persistQueue'
import { SqliteConversationStore } from './sqliteConversationStore'

export type SessionStoreMode = 'memory' | 'sqlite' | 'dual'

export interface ConversationStoreFactoryOptions {
  mode: SessionStoreMode
  /** Absolute path to `state.db`. Required for `sqlite`/`dual`. */
  dbPath?: string
  cacheSize: number
  syncTimeoutMs: number
  asyncTimeoutMs: number
  /** Progress bound of the persist queue (`PersistQueueOptions.stallTimeoutMs`). */
  stallTimeoutMs: number
  checkpointEveryWrites: number
  heartbeatMs: number
  /**
   * D3 — durability barrier (`PRAGMA synchronous = FULL` in the worker).
   * Set when the stateless lifecycle is enabled or `CLERUM_DB_BARRIER_MODE=full`.
   */
  barrierMode?: boolean
  /** TTL for persisted pending-approval rows. Defaults to 7d inside the store. */
  pendingApprovalTtlMs?: number
  /** Optional override for the compiled worker script path (used by tests). */
  workerScriptPath?: string
  /**
   * Called once when the persist queue becomes unusable (unexpected worker
   * exit or a failed async write). `main.ts` ends the process here.
   */
  onPersistFailure?: (err: Error) => void
}

export interface ConversationStoreHandle {
  store: ConversationStore
  mode: SessionStoreMode
  /** Graceful shutdown — drains pending writes, terminates the worker. */
  shutdown(): Promise<void>
  /** Returns the underlying worker for tests / diagnostics. May be undefined
   *  for `memory` mode. */
  worker?: Worker
  persistQueue?: PersistQueue
}

function resolveWorkerScript(override?: string): string {
  if (override) return override
  // Worker script lives next to this file at runtime. After `tsc` build the
  // module path is `dist/db/worker/dbWorker.js`; in `ts-node` it's the same
  // resolution via the source map.
  return path.resolve(__dirname, '..', '..', '..', 'db', 'worker', 'dbWorker.js')
}

function spawnWorker(opts: ConversationStoreFactoryOptions): Worker {
  if (!opts.dbPath) {
    throw new Error('conversationStoreFactory: dbPath is required for sqlite/dual mode')
  }
  const scriptPath = resolveWorkerScript(opts.workerScriptPath)
  return new Worker(scriptPath, {
    workerData: {
      dbPath: opts.dbPath,
      checkpointEveryWrites: opts.checkpointEveryWrites,
      heartbeatMs: opts.heartbeatMs,
      barrierMode: opts.barrierMode === true,
    },
  })
}

export function createConversationStore(
  opts: ConversationStoreFactoryOptions
): ConversationStoreHandle {
  if (opts.mode === 'memory') {
    const store = new InMemoryConversationStore()
    return {
      store,
      mode: 'memory',
      async shutdown() {
        /* nothing to drain */
      },
    }
  }

  const worker = spawnWorker(opts) as unknown as WorkerLike & Worker
  const persistQueue = new PersistQueue(worker, {
    syncTimeoutMs: opts.syncTimeoutMs,
    asyncTimeoutMs: opts.asyncTimeoutMs,
    stallTimeoutMs: opts.stallTimeoutMs,
    onTransportError: err => {
      logger.error({ err }, '[ConversationStore] worker transport error')
    },
    onExit: code => {
      logger.error({ code }, '[ConversationStore] worker exited; writes are rejected')
    },
    onFailure: opts.onPersistFailure,
  })
  // The worker answers only after it has opened and migrated the database, so
  // the path is logged once that is true. One line per process names the
  // database this Host reads and writes, so a Pod replacement that changes the
  // store is visible in the Pod logs. A worker exit before the answer rejects
  // the ping and fires `onFailure`; in production the process then exits 1
  // once the pre-exit flush ends, so this handler still logs, next to the
  // worker's fatal log and the exit log that name the cause.
  persistQueue.awaitOpen().then(
    () => logger.info({ dbPath: opts.dbPath, mode: opts.mode }, '[ConversationStore] opened'),
    (err: unknown) => logger.error({ err }, '[ConversationStore] database did not open')
  )

  const sqliteStore = new SqliteConversationStore(persistQueue, {
    cacheSize: opts.cacheSize,
    pendingApprovalTtlMs: opts.pendingApprovalTtlMs,
  })

  if (opts.mode === 'sqlite') {
    return {
      store: sqliteStore,
      mode: 'sqlite',
      worker: worker as Worker,
      persistQueue,
      async shutdown() {
        await sqliteStore.shutdown()
      },
    }
  }

  // dual
  const memoryStore = new InMemoryConversationStore()
  const dual = new DualConversationStore(memoryStore, sqliteStore)
  return {
    store: dual,
    mode: 'dual',
    worker: worker as Worker,
    persistQueue,
    async shutdown() {
      await dual.shutdown()
    },
  }
}
