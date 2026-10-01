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
import {
  type CanonicalStoreRuntimeOptions,
  assertCanonicalRuntimeConfig,
  assertUncoordinatedStoreBootAllowed,
  requiresExistingStore,
} from '../../../canonicalStoreBootGuard'
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
  checkpointEveryWrites: number
  heartbeatMs: number
  /**
   * D3 — durability barrier (`PRAGMA synchronous = FULL` in the worker).
   * Set when the stateless lifecycle is enabled or `CLERUM_DB_BARRIER_MODE=full`.
   */
  barrierMode?: boolean
  canonicalStore?: CanonicalStoreRuntimeOptions
  /** Fatal transport or fence loss closes runtime admission; it is never silently reopened. */
  onFatalWorkerError?: (err: Error) => void
  /** TTL for persisted pending-approval rows. Defaults to 7d inside the store. */
  pendingApprovalTtlMs?: number
  /** Optional override for the compiled worker script path (used by tests). */
  workerScriptPath?: string
}

export interface ConversationStoreHandle {
  store: ConversationStore
  mode: SessionStoreMode
  /** Graceful shutdown — drains pending writes, terminates the worker. */
  shutdown(): Promise<void>
  /** Resolves only after the worker has acquired its fence and validated the existing store. */
  ready: Promise<void>
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
      barrierMode:
        opts.barrierMode === true ||
        (opts.canonicalStore ? requiresExistingStore(opts.canonicalStore) : false),
      canonicalStore: opts.canonicalStore,
    },
  })
}

export function createConversationStore(
  opts: ConversationStoreFactoryOptions
): ConversationStoreHandle {
  if (opts.canonicalStore) assertCanonicalRuntimeConfig(opts.mode, opts.dbPath, opts.canonicalStore)
  if (opts.mode === 'memory') {
    if (!opts.canonicalStore && opts.dbPath) assertUncoordinatedStoreBootAllowed(opts.dbPath)
    const store = new InMemoryConversationStore()
    return {
      store,
      mode: 'memory',
      ready: Promise.resolve(),
      async shutdown() {
        /* nothing to drain */
      },
    }
  }

  const worker = spawnWorker(opts) as unknown as WorkerLike & Worker
  const persistQueue = new PersistQueue(worker, {
    syncTimeoutMs: opts.syncTimeoutMs,
    asyncTimeoutMs: opts.asyncTimeoutMs,
    onTransportError: err => {
      logger.error({ err }, '[ConversationStore] worker transport failed')
      opts.onFatalWorkerError?.(err)
    },
    onExit: code => {
      logger.info({ code }, '[ConversationStore] worker exited')
      if (code !== 0) opts.onFatalWorkerError?.(new Error('ConversationStoreWorkerExited'))
    },
  })

  const ready = persistQueue.enqueueSync({ kind: 'ping' }).then(() => undefined)
  // A caller can await readiness after wiring its handle without an unhandled rejection gap.
  void ready.catch(() => undefined)

  const sqliteStore = new SqliteConversationStore(persistQueue, {
    cacheSize: opts.cacheSize,
    pendingApprovalTtlMs: opts.pendingApprovalTtlMs,
  })

  if (opts.mode === 'sqlite') {
    return {
      store: sqliteStore,
      mode: 'sqlite',
      ready,
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
    ready,
    worker: worker as Worker,
    persistQueue,
    async shutdown() {
      await dual.shutdown()
    },
  }
}
