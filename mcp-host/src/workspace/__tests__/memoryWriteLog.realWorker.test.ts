import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { PersistQueue, type WorkerLike } from '../../core/conversation/persistence/persistQueue'
import { MCP_HOST_ROOT, compileSources } from '../../db/worker/__tests__/compileSources'
import type { WorkerMessage, WorkerReply } from '../../db/worker/protocol'
import { type MemoryWriteEntry, SqliteMemoryWriteLog } from '../memoryWriteLog'

// SqliteMemoryWriteLog.record through a real PersistQueue and the compiled DB
// worker: the row reaches the database file, a dead worker rejects, and a sync
// timeout rejects although the row can still land (the port's contract is
// "a rejection does not mean the row is absent").

let tmpRoot: string
let workerScript: string

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-write-log-real-worker-'))
  fs.symlinkSync(path.join(MCP_HOST_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'))
  ;[workerScript] = compileSources(['db/worker/dbWorker.ts'], path.join(tmpRoot, 'dist'))
}, 120_000)

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function entry(relativePath: string): MemoryWriteEntry {
  return {
    userKey: 'a1b2c3d4e5f60718',
    scope: 'user',
    relativePath,
    mode: 'append',
    contentSha256: 'c'.repeat(64),
    writtenAt: 1_700_000_000.25,
  }
}

function rows(dbPath: string): Array<{ relative_path: string; content_sha256: string }> {
  const reader = new Database(dbPath, { readonly: true })
  try {
    return reader
      .prepare('SELECT relative_path, content_sha256 FROM memory_writes ORDER BY id')
      .all() as Array<{ relative_path: string; content_sha256: string }>
  } finally {
    reader.close()
  }
}

function startWorker(dbPath: string): Worker {
  return new Worker(workerScript, {
    workerData: { dbPath, checkpointEveryWrites: 100, heartbeatMs: 60_000 },
  })
}

/**
 * Test-only WorkerLike around the real worker: the reply to every
 * `insert_memory_write` is held until `release()`, so the queue's sync timeout
 * expires while the worker has already stored the row.
 */
class HoldingWorker implements WorkerLike {
  private readonly heldIds = new Set<string>()
  private readonly held: WorkerReply[] = []
  private messageListener: ((reply: WorkerReply) => void) | undefined

  constructor(private readonly inner: Worker) {
    inner.on('message', (reply: WorkerReply) => {
      if (this.heldIds.has(reply.id)) this.held.push(reply)
      else this.messageListener?.(reply)
    })
  }

  postMessage(msg: WorkerMessage): void {
    if (msg.op.kind === 'insert_memory_write') this.heldIds.add(msg.id)
    this.inner.postMessage(msg)
  }

  on(event: 'message', listener: (reply: WorkerReply) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void {
    if (event === 'message') this.messageListener = listener as (reply: WorkerReply) => void
    else this.inner.on(event, listener as (arg: unknown) => void)
  }

  heldCount(): number {
    return this.held.length
  }

  release(): void {
    for (const reply of this.held.splice(0)) this.messageListener?.(reply)
  }

  terminate(): Promise<number> {
    return this.inner.terminate()
  }
}

describe('SqliteMemoryWriteLog on the real DB worker', () => {
  it('stores the row, and rejects once the worker is gone', async () => {
    const dbPath = path.join(tmpRoot, 'record.db')
    const worker = startWorker(dbPath)
    const failures: Error[] = []
    const queue = new PersistQueue(worker, {
      syncTimeoutMs: 5000,
      asyncTimeoutMs: 5000,
      stallTimeoutMs: 30_000,
      onFailure: err => failures.push(err),
    })
    await queue.awaitOpen()
    const log = new SqliteMemoryWriteLog(queue)

    await expect(log.record(entry('memory/first.md'))).resolves.toBeUndefined()
    expect(rows(dbPath)).toEqual([
      { relative_path: 'memory/first.md', content_sha256: 'c'.repeat(64) },
    ])

    await worker.terminate()
    await expect(log.record(entry('memory/second.md'))).rejects.toThrow()
    expect(rows(dbPath)).toEqual([
      { relative_path: 'memory/first.md', content_sha256: 'c'.repeat(64) },
    ])
  }, 60_000)

  it('rejects on the sync timeout although the row lands', async () => {
    const dbPath = path.join(tmpRoot, 'timeout.db')
    const holding = new HoldingWorker(startWorker(dbPath))
    const failures: Error[] = []
    const queue = new PersistQueue(holding, {
      syncTimeoutMs: 200,
      asyncTimeoutMs: 200,
      // Above the hold: the queue must not record a stall while the reply is held.
      stallTimeoutMs: 30_000,
      onFailure: err => failures.push(err),
    })
    try {
      await queue.awaitOpen()
      const log = new SqliteMemoryWriteLog(queue)

      let rejection: Error | undefined
      await log.record(entry('memory/late.md')).catch((err: Error) => {
        rejection = err
      })
      // The rejection is observed before the row is read.
      expect(rejection?.message).toBe('db worker timeout (200ms) for op=insert_memory_write')
      expect(holding.heldCount()).toBe(1)

      holding.release()
      expect(rows(dbPath)).toEqual([
        { relative_path: 'memory/late.md', content_sha256: 'c'.repeat(64) },
      ])
      expect(failures).toEqual([])
    } finally {
      await queue.close()
    }
  }, 60_000)
})
