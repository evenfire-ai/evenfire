import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import type { WorkerMessage, WorkerOp, WorkerReply } from '../../../../db/worker/protocol'
import { PersistQueue, type WorkerLike } from '../persistQueue'

class FakeWorker extends EventEmitter implements WorkerLike {
  public sent: WorkerMessage[] = []
  postMessage(msg: WorkerMessage): void {
    this.sent.push(msg)
  }
  terminate(): void {
    this.emit('exit', 0)
  }
  override on(event: 'message', listener: (reply: WorkerReply) => void): this
  override on(event: 'error', listener: (err: Error) => void): this
  override on(event: 'exit', listener: (code: number) => void): this
  override on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener as (...args: unknown[]) => void)
    return this
  }
}

describe('PersistQueue', () => {
  it('resolves enqueueSync when worker replies ok', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 200,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    const promise = q.enqueueSync({ kind: 'ping' })
    const sent = worker.sent[0]
    worker.emit('message', { id: sent.id, ok: true, result: 'pong' } satisfies WorkerReply)
    await expect(promise).resolves.toBe('pong')
  })

  it.each([
    ['ok', { ok: true, result: 'pong' }],
    ['error', { ok: false, error: { code: 'BOOM', message: 'kaboom' } }],
  ] as const)(
    'drops the chain entry of a keyed enqueueSync once its %s reply settles',
    async (_label, reply) => {
      const worker = new FakeWorker()
      const q = new PersistQueue(worker, {
        syncTimeoutMs: 200,
        asyncTimeoutMs: 500,
        stallTimeoutMs: 30_000,
      })
      const chains = (q as unknown as { writeChain: Map<string, unknown> }).writeChain
      const promise = q.enqueueSync({ kind: 'ping' }, 'session-1').catch((err: Error) => err)
      // Liveness witness: the write is chained under its key while in flight.
      expect(chains.has('session-1')).toBe(true)
      await vi.waitFor(() => expect(worker.sent).toHaveLength(1))
      worker.emit('message', { id: worker.sent[0].id, ...reply } as WorkerReply)
      const outcome = await promise
      expect(outcome instanceof Error ? outcome.message : outcome).toBe(
        reply.ok ? 'pong' : 'kaboom'
      )
      await vi.waitFor(() => expect(chains.has('session-1')).toBe(false))
    }
  )

  it('rejects enqueueSync when worker replies with error', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 200,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    const promise = q.enqueueSync({ kind: 'ping' })
    const sent = worker.sent[0]
    worker.emit('message', {
      id: sent.id,
      ok: false,
      error: { code: 'BOOM', message: 'kaboom' },
    } satisfies WorkerReply)
    await expect(promise).rejects.toThrow(/kaboom/)
  })

  it('times out enqueueSync', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 30,
      asyncTimeoutMs: 30,
      stallTimeoutMs: 30_000,
    })
    await expect(q.enqueueSync({ kind: 'ping' })).rejects.toThrow(/timeout/)
  })

  it('awaitOpen outlasts the sync timeout and resolves on the worker reply', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 30,
      asyncTimeoutMs: 30,
      stallTimeoutMs: 30_000,
    })
    let settled = false
    const open = q.awaitOpen().finally(() => {
      settled = true
    })
    // Liveness witness: the ping was posted to the worker.
    expect(worker.sent.map(m => m.op.kind)).toEqual(['ping'])
    await new Promise(r => setTimeout(r, 90))
    expect(settled).toBe(false)
    worker.emit('message', {
      id: worker.sent[0].id,
      ok: true,
      result: 'pong',
    } satisfies WorkerReply)
    await expect(open).resolves.toBeUndefined()
  })

  it('awaitOpen rejects when the worker exits before answering', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 30,
      asyncTimeoutMs: 30,
      stallTimeoutMs: 30_000,
    })
    const open = q.awaitOpen()
    expect(worker.sent.map(m => m.op.kind)).toEqual(['ping'])
    worker.emit('exit', 1)
    await expect(open).rejects.toThrow(/exited/)
  })

  it('enqueueAsync preserves order per sessionKey', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 200,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    q.enqueueAsync('s1', { kind: 'ping' })
    q.enqueueAsync('s1', { kind: 'ping' })
    // After microtasks the first one is sent but the second is awaiting the
    // first's reply (write chain).
    await Promise.resolve()
    expect(worker.sent.length).toBe(1)
    // Resolve the first one — the second should fire.
    worker.emit('message', { id: worker.sent[0].id, ok: true, result: null } satisfies WorkerReply)
    await new Promise(r => setImmediate(r))
    expect(worker.sent.length).toBe(2)
  })

  it('drainPrefix waits only for chains whose sessionKey matches the prefix', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 200,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    // Two in-flight async writes under the same prefix + one unrelated key.
    q.enqueueAsync('alice:rpc:a:1', { kind: 'ping' })
    q.enqueueAsync('alice:rpc:b:2', { kind: 'ping' })
    q.enqueueAsync('bob:rpc:c:3', { kind: 'ping' })
    await Promise.resolve()
    expect(worker.sent.length).toBe(3)

    let drained = false
    const drainPromise = q.drainPrefix('alice:rpc:').then(() => {
      drained = true
    })
    // Not settled while the matching writes are still pending.
    await new Promise(r => setImmediate(r))
    expect(drained).toBe(false)

    // Reply to the two alice ops only → drainPrefix settles without waiting on bob.
    for (const msg of worker.sent.filter(m => m.id !== worker.sent[2].id)) {
      worker.emit('message', { id: msg.id, ok: true, result: null } satisfies WorkerReply)
    }
    await drainPromise
    expect(drained).toBe(true)
  })

  it('rejects pending writes when the worker exits', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    const promise = q.enqueueSync({ kind: 'ping' })
    worker.emit('exit', 137)
    await expect(promise).rejects.toThrow(/db worker exited/)
  })

  it('rejects async writes admitted after the worker exited instead of dropping them', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    // Liveness witness: while the worker is alive the async write is posted.
    expect(worker.sent).toHaveLength(1)

    worker.emit('exit', 137)
    expect(() => q.enqueueAsync('s1', { kind: 'ping' })).toThrow(/db worker exited \(code=137\)/)
    expect(worker.sent).toHaveLength(1)
  })

  it('fails the next write on the same queue after an async write failed', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    // Witness: a sync write before any failure resolves.
    const first = q.enqueueSync({ kind: 'ping' })
    worker.emit('message', {
      id: worker.sent[0].id,
      ok: true,
      result: 'pong',
    } satisfies WorkerReply)
    await expect(first).resolves.toBe('pong')

    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    worker.emit('message', {
      id: worker.sent[1].id,
      ok: false,
      error: { code: 'SQLITE_FULL', message: 'database or disk is full' },
    } satisfies WorkerReply)
    await new Promise(r => setImmediate(r))

    await expect(q.enqueueSync({ kind: 'ping' })).rejects.toThrow(
      /async write failed \(sessionKey=s1\): database or disk is full/
    )
    expect(() => q.enqueueAsync('s2', { kind: 'ping' })).toThrow(/database or disk is full/)
  })

  it('calls onExit and onFailure once when the worker exits unexpectedly', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const exits: number[] = []
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
      onFailure: err => failures.push(err),
      onExit: code => exits.push(code),
    })
    // Liveness witness: with the worker alive a write is acknowledged and
    // onFailure has not fired.
    const ok = q.enqueueSync({ kind: 'ping' })
    worker.emit('message', {
      id: worker.sent[0].id,
      ok: true,
      result: 'pong',
    } satisfies WorkerReply)
    await expect(ok).resolves.toBe('pong')
    expect(failures).toHaveLength(0)

    worker.emit('exit', 1)
    expect(exits).toEqual([1])
    expect(failures.map(e => e.message)).toEqual(['db worker exited (code=1)'])
    // A later rejected write does not report a second failure.
    expect(() => q.enqueueAsync('s1', { kind: 'ping' })).toThrow(/db worker exited/)
    expect(failures).toHaveLength(1)
  })

  it('calls onFailure once when an async write fails', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
      onFailure: err => failures.push(err),
    })
    q.enqueueAsync('s1', { kind: 'ping' })
    q.enqueueAsync('s2', { kind: 'ping' })
    await Promise.resolve()
    expect(worker.sent).toHaveLength(2)

    // Liveness witness: an acknowledged async write does not fire onFailure.
    worker.emit('message', {
      id: worker.sent[0].id,
      ok: true,
      result: 'pong',
    } satisfies WorkerReply)
    await new Promise(r => setImmediate(r))
    expect(failures).toHaveLength(0)

    worker.emit('message', {
      id: worker.sent[1].id,
      ok: false,
      error: { code: 'SQLITE_FULL', message: 'database or disk is full' },
    } satisfies WorkerReply)
    await new Promise(r => setImmediate(r))
    expect(failures.map(e => e.message)).toEqual([
      'async write failed (sessionKey=s2): database or disk is full',
    ])

    // A worker exit after the failure does not report a second one.
    worker.emit('exit', 1)
    expect(failures).toHaveLength(1)
  })

  it('keeps a slow async write pending past asyncTimeoutMs and its key ordered until the ACK', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 20,
      stallTimeoutMs: 30_000,
      onFailure: err => failures.push(err),
    })
    q.enqueueAsync('s1', { kind: 'ping' })
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    // Liveness witness: the first write was posted.
    expect(worker.sent).toHaveLength(1)
    await new Promise(r => setTimeout(r, 80))
    // Past the threshold: still pending, the second write still queued behind it.
    expect(failures).toHaveLength(0)
    expect(worker.sent).toHaveLength(1)

    worker.emit('message', { id: worker.sent[0].id, ok: true, result: null } satisfies WorkerReply)
    await new Promise(r => setImmediate(r))
    expect(worker.sent).toHaveLength(2)
    worker.emit('message', { id: worker.sent[1].id, ok: true, result: null } satisfies WorkerReply)
    await q.drainSessionKey('s1')
    expect(failures).toHaveLength(0)
    // A later write on the same key is still admitted.
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    expect(worker.sent).toHaveLength(3)
  })

  it('reports neither onFailure nor onExit for the worker exit that follows a shutdown ACK', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const reportedExits: number[] = []
    const observedExits: number[] = []
    worker.on('exit', code => observedExits.push(code))
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
      onFailure: err => failures.push(err),
      onExit: code => reportedExits.push(code),
    })
    const closing = q.close()
    await new Promise(r => setImmediate(r))
    const shutdown = worker.sent.find(m => m.op.kind === 'shutdown')
    expect(shutdown).toBeDefined()
    worker.emit('message', { id: shutdown!.id, ok: true, result: null } satisfies WorkerReply)
    // FakeWorker.terminate() emits the exit.
    await closing
    // Liveness witness: the exit was observed.
    expect(observedExits).toEqual([0])
    expect(reportedExits).toHaveLength(0)
    expect(failures).toHaveLength(0)
  })

  it('waits for the worker shutdown ACK before terminating it', async () => {
    const worker = new FakeWorker()
    let terminateCalls = 0
    worker.terminate = () => {
      terminateCalls += 1
    }
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    const closing = q.close()
    await new Promise(r => setImmediate(r))

    const shutdown = worker.sent.find(m => m.op.kind === 'shutdown')
    // Witness: the shutdown op was posted.
    expect(shutdown).toBeDefined()
    expect(terminateCalls).toBe(0)

    worker.emit('message', { id: shutdown!.id, ok: true, result: null } satisfies WorkerReply)
    await closing
    expect(terminateCalls).toBe(1)
  })

  it('drains queued async writes before posting shutdown and rejects close on a failed one', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    const closing = q.close()
    await new Promise(r => setImmediate(r))
    // The queued write is still in flight, so shutdown is not posted yet.
    expect(worker.sent.map(m => m.op.kind)).toEqual(['ping'])

    worker.emit('message', {
      id: worker.sent[0].id,
      ok: false,
      error: { code: 'SQLITE_IOERR', message: 'disk I/O error' },
    } satisfies WorkerReply)
    await new Promise(r => setImmediate(r))
    const shutdown = worker.sent.find(m => m.op.kind === 'shutdown')
    expect(shutdown).toBeDefined()
    worker.emit('message', { id: shutdown!.id, ok: true, result: null } satisfies WorkerReply)
    await expect(closing).rejects.toThrow(/disk I\/O error/)
  })

  it('never posts a write chained behind a failed async write on the same key', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    q.enqueueAsync('s1', { kind: 'ping' })
    q.enqueueAsync('s1', { kind: 'ping' })
    const chainedSync = q.enqueueSync({ kind: 'ping' }, 's1')
    await Promise.resolve()
    // Liveness witness: the first write was posted; the others wait on it.
    expect(worker.sent.map(m => m.op.kind)).toEqual(['ping'])

    worker.emit('message', {
      id: worker.sent[0].id,
      ok: false,
      error: { code: 'SQLITE_FULL', message: 'database or disk is full' },
    } satisfies WorkerReply)
    await expect(chainedSync).rejects.toThrow(
      /async write failed \(sessionKey=s1\): database or disk is full/
    )
    await new Promise(r => setImmediate(r))
    expect(worker.sent).toHaveLength(1)
  })

  it('resolves a concurrent second close only after the shutdown ACK', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
    })
    let secondSettled = false
    const first = q.close()
    const second = q.close().finally(() => {
      secondSettled = true
    })
    await new Promise(r => setImmediate(r))
    const shutdowns = worker.sent.filter(m => m.op.kind === 'shutdown')
    // Witness: exactly one shutdown was posted, and it is not ACKed yet.
    expect(shutdowns).toHaveLength(1)
    expect(secondSettled).toBe(false)

    worker.emit('message', { id: shutdowns[0].id, ok: true, result: null } satisfies WorkerReply)
    await Promise.all([first, second])
    expect(secondSettled).toBe(true)
  })

  it('rejects close when the worker reports a shutdown failure', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      stallTimeoutMs: 30_000,
      onFailure: err => failures.push(err),
    })
    const closing = q.close()
    await new Promise(r => setImmediate(r))
    const shutdown = worker.sent.find(m => m.op.kind === 'shutdown')
    expect(shutdown).toBeDefined()
    worker.emit('message', {
      id: shutdown!.id,
      ok: false,
      error: { code: 'SQLITE_BUSY', message: 'database is locked' },
    } satisfies WorkerReply)
    await expect(closing).rejects.toThrow(/database is locked/)
    // The shutdown failure is the queue's failure; the exit that terminate()
    // causes afterwards is not reported as a second one.
    expect(failures.map(e => e.message)).toEqual(['database is locked'])
  })
})

// A slow worker and a wedged worker differ in progress, not in how long a
// write waits: a slow worker keeps completing operations, a wedged one stops.
// These cases pin both, in service and at close(), so a change that fixes one
// by breaking another fails here.
describe('PersistQueue progress bound: slow vs wedged, in service and at close()', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const ack = (worker: FakeWorker, msg: WorkerMessage) =>
    worker.emit('message', { id: msg.id, ok: true, result: null } satisfies WorkerReply)

  /** A queue whose open ping was answered, so the progress bound is armed. */
  async function openQueue(opts: {
    stallTimeoutMs: number
    asyncTimeoutMs?: number
    syncTimeoutMs?: number
  }) {
    const worker = new FakeWorker()
    const failures: Error[] = []
    let terminateCalls = 0
    worker.terminate = () => {
      terminateCalls += 1
      worker.emit('exit', 1)
    }
    const q = new PersistQueue(worker, {
      syncTimeoutMs: opts.syncTimeoutMs ?? 5000,
      asyncTimeoutMs: opts.asyncTimeoutMs ?? 5000,
      stallTimeoutMs: opts.stallTimeoutMs,
      onFailure: err => failures.push(err),
    })
    const open = q.awaitOpen()
    ack(worker, worker.sent[0])
    await open
    return { worker, q, failures, terminateCalls: () => terminateCalls }
  }

  /**
   * Answers every posted operation in order, one at a time, `delayMs` after
   * the previous answer: a single-writer worker that is slow but alive.
   */
  function autoAck(worker: FakeWorker, delayMs: number): WorkerMessage[] {
    const acked: WorkerMessage[] = []
    let busy = false
    const queue: WorkerMessage[] = []
    const next = () => {
      const msg = queue.shift()
      if (!msg) {
        busy = false
        return
      }
      busy = true
      setTimeout(() => {
        acked.push(msg)
        ack(worker, msg)
        next()
      }, delayMs)
    }
    const post = worker.postMessage.bind(worker)
    worker.postMessage = msg => {
      post(msg)
      queue.push(msg)
      if (!busy) next()
    }
    return acked
  }

  it('fails a wedged worker in service within the bound and releases everything queued behind it', async () => {
    const { worker, q, failures, terminateCalls } = await openQueue({
      stallTimeoutMs: 100,
      asyncTimeoutMs: 20,
    })
    // Liveness witness: a write on the same key is acknowledged first.
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    ack(worker, worker.sent[1])
    await q.drainSessionKey('s1')
    expect(failures).toHaveLength(0)

    // The worker stops answering.
    q.enqueueAsync('s1', { kind: 'ping' })
    const keyedSync = q.enqueueSync({ kind: 'ping' }, 's1')
    await Promise.resolve()
    expect(worker.sent).toHaveLength(3)
    const started = Date.now()
    const prefixDrained = q.drainPrefix('s')

    await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 1000, interval: 5 })
    expect(Date.now() - started).toBeLessThan(400)
    expect(failures[0].message).toMatch(/db worker made no progress for 100ms/)
    await expect(keyedSync).rejects.toBe(failures[0])
    await prefixDrained
    expect(terminateCalls()).toBe(1)
    // The write chained behind the stalled one was never posted.
    expect(worker.sent).toHaveLength(3)
    expect(() => q.enqueueAsync('s2', { kind: 'ping' })).toThrow(failures[0].message)
  })

  it('never fails a slow but alive worker with a backlog far longer than the bound', async () => {
    // A 10x margin between the ACK gap and the bound keeps this stable under load.
    const { worker, q, failures } = await openQueue({ stallTimeoutMs: 500, asyncTimeoutMs: 20 })
    const acked = autoAck(worker, 50)
    const keys = ['a', 'b', 'c']
    // The tag only identifies the write in this test; the queue never reads it.
    const tagged = (tag: string) => ({ kind: 'ping', tag }) as WorkerOp
    for (let i = 0; i < 10; i++) {
      for (const key of keys) q.enqueueAsync(key, tagged(`${key}${i}`))
    }
    await Promise.all(keys.map(k => q.drainSessionKey(k)))
    const tags = acked.map(m => (m.op as WorkerOp & { tag: string }).tag)
    // Liveness witness: all 30 writes were acknowledged, 1.5 s of backlog
    // against a 500 ms bound, each key in its enqueue order.
    expect(tags).toHaveLength(30)
    for (const key of keys) {
      expect(tags.filter(t => t.startsWith(key))).toEqual(
        Array.from({ length: 10 }, (_, i) => `${key}${i}`)
      )
    }
    expect(failures).toHaveLength(0)
  })

  it('drains a slow backlog completely on close() before posting shutdown', async () => {
    const { worker, q, failures } = await openQueue({ stallTimeoutMs: 1000, asyncTimeoutMs: 50 })
    const acked = autoAck(worker, 10)
    for (let i = 0; i < 10; i++) q.enqueueAsync('s1', { kind: 'ping' })
    await q.close()
    const kinds = acked.map(m => m.op.kind)
    // Liveness witness: the ten writes and then shutdown were acknowledged.
    expect(kinds).toEqual([...Array(10).fill('ping'), 'shutdown'])
    expect(failures).toHaveLength(0)
  })

  it('drains on close() a backlog longer than twice the bound, with no total deadline', async () => {
    const { worker, q, failures } = await openQueue({ stallTimeoutMs: 500 })
    const acked = autoAck(worker, 50)
    for (let i = 0; i < 30; i++) q.enqueueAsync('s1', { kind: 'ping' })
    const started = Date.now()
    await expect(q.close()).resolves.toBeUndefined()
    // Liveness witness: 30 writes, then shutdown, all acknowledged; the
    // backlog (30 x 50 ms) is longer than 2x the 500 ms bound.
    expect(acked.map(m => m.op.kind)).toEqual([...Array(30).fill('ping'), 'shutdown'])
    expect(Date.now() - started).toBeGreaterThan(1000)
    expect(failures).toHaveLength(0)
  })

  it('does not count idle time against the bound on the next write', async () => {
    const { worker, q, failures } = await openQueue({ stallTimeoutMs: 200 })
    // Idle for twice the bound with nothing in flight.
    await sleep(400)
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    expect(worker.sent).toHaveLength(2)
    await sleep(20)
    ack(worker, worker.sent[1])
    // Liveness witness: the write was posted and its ACK drained the key.
    await q.drainSessionKey('s1')
    expect(worker.sent[1].op.kind).toBe('ping')
    await sleep(50)
    expect(failures).toHaveLength(0)
  })

  it('fails close() within the bound when the worker is wedged', async () => {
    const { worker, q, failures, terminateCalls } = await openQueue({ stallTimeoutMs: 100 })
    // Liveness witness: a write is acknowledged before the worker stops.
    const first = q.enqueueSync({ kind: 'ping' })
    ack(worker, worker.sent[1])
    await first
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    const started = Date.now()
    await expect(q.close()).rejects.toThrow(/db worker made no progress for 100ms/)
    expect(Date.now() - started).toBeLessThan(400)
    expect(terminateCalls()).toBe(1)
    expect(failures).toHaveLength(1)
    expect(worker.sent.map(m => m.op.kind)).not.toContain('shutdown')
  })

  it('waits on close() for a sync write without a sessionKey before posting shutdown', async () => {
    const { worker, q } = await openQueue({ stallTimeoutMs: 1000 })
    const unkeyed = q.enqueueSync<string>({ kind: 'ping' })
    const closing = q.close()
    await sleep(20)
    expect(worker.sent.map(m => m.op.kind)).toEqual(['ping', 'ping'])

    worker.emit('message', {
      id: worker.sent[1].id,
      ok: true,
      result: 'pong',
    } satisfies WorkerReply)
    // Liveness witness: the sync write resolves with the worker's result.
    await expect(unkeyed).resolves.toBe('pong')
    await vi.waitFor(() => expect(worker.sent.map(m => m.op.kind)).toContain('shutdown'))
    ack(worker, worker.sent[2])
    await closing
  })

  it('does not fail a healthy worker whose answer waited behind a main-thread stall', async () => {
    const realWorker = new Worker(
      `const { parentPort } = require('node:worker_threads')
       parentPort.on('message', msg => setTimeout(() => parentPort.postMessage({ id: msg.id, ok: true, result: null }), 10))`,
      { eval: true }
    )
    const failures: Error[] = []
    const q = new PersistQueue(realWorker as unknown as WorkerLike, {
      syncTimeoutMs: 5000,
      asyncTimeoutMs: 5000,
      stallTimeoutMs: 100,
      onFailure: err => failures.push(err),
    })
    try {
      await q.awaitOpen()
      const write = q.enqueueSync({ kind: 'ping' }, 's1')
      await sleep(1)
      // The main thread is blocked well past the bound while the answer
      // waits in the port. Blocking in the check phase makes the next loop
      // iteration run the overdue timer before the poll phase reads the
      // answer (blocking in the timers phase would not: libuv compares
      // timers against the loop time cached when that phase started).
      await new Promise<void>(resolve =>
        setImmediate(() => {
          const until = Date.now() + 300
          while (Date.now() < until) {
            /* block the event loop */
          }
          resolve()
        })
      )
      // Liveness witness: the write resolves.
      await expect(write).resolves.toBeNull()
      await sleep(150)
      expect(failures).toHaveLength(0)
    } finally {
      await realWorker.terminate()
    }
  })

  it('does not start the bound before the database is open', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 5000,
      asyncTimeoutMs: 5000,
      stallTimeoutMs: 100,
      onFailure: err => failures.push(err),
    })
    const open = q.awaitOpen()
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    expect(worker.sent).toHaveLength(2)
    await sleep(300)
    expect(failures).toHaveLength(0)

    ack(worker, worker.sent[0])
    await open
    ack(worker, worker.sent[1])
    await q.drainSessionKey('s1')
    expect(failures).toHaveLength(0)

    // Liveness witness: once open, a wedged write does fail the queue.
    q.enqueueAsync('s1', { kind: 'ping' })
    await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 1000, interval: 5 })
    expect(failures[0].message).toMatch(/no progress for 100ms/)
  })

  it('fails close() within the bound when the worker never answers the open ping', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 5000,
      asyncTimeoutMs: 5000,
      stallTimeoutMs: 100,
      onFailure: err => failures.push(err),
    })
    const open = q.awaitOpen().catch((err: unknown) => err)
    q.enqueueAsync('s1', { kind: 'ping' })
    await Promise.resolve()
    // Both are posted before close(), so nothing sent after it can arm the bound.
    expect(worker.sent).toHaveLength(2)
    const closing = q.close()
    let settled = false
    const outcome = closing.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err })
    )
    void outcome.then(() => {
      settled = true
    })
    const started = Date.now()
    // Bounded wait, so a hang fails the assertion instead of the test timeout.
    await Promise.race([outcome, sleep(500)])
    // Liveness witnesses: the open ping was posted, and close() started.
    expect(worker.sent[0].op.kind).toBe('ping')
    expect(() => q.enqueueAsync('s2', { kind: 'ping' })).toThrow()
    expect(settled).toBe(true)
    const result = await outcome
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.err.message).toMatch(/db worker made no progress for 100ms/)
    expect(Date.now() - started).toBeLessThan(500)
    expect(failures).toHaveLength(1)
    expect(await open).toBe(failures[0])
  })

  it('lets a slow but healthy open finish during close()', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    let terminateCalls = 0
    worker.terminate = () => {
      terminateCalls += 1
      worker.emit('exit', 0)
    }
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 5000,
      asyncTimeoutMs: 5000,
      stallTimeoutMs: 300,
      onFailure: err => failures.push(err),
    })
    const open = q.awaitOpen()
    q.enqueueAsync('s1', { kind: 'ping' })
    // The open takes longer than the bound before close() starts; the bound
    // counts from close(), not from the ping.
    await sleep(400)
    expect(worker.sent).toHaveLength(2)
    const closing = q.close()
    await sleep(30)
    ack(worker, worker.sent[0])
    await open
    ack(worker, worker.sent[1])
    await vi.waitFor(() => expect(worker.sent.map(m => m.op.kind)).toContain('shutdown'))
    // Liveness witness: the async write was acknowledged and shutdown posted.
    expect(worker.sent.map(m => m.op.kind)).toEqual(['ping', 'ping', 'shutdown'])
    ack(worker, worker.sent[2])
    await expect(closing).resolves.toBeUndefined()
    expect(failures).toHaveLength(0)
    expect(terminateCalls).toBe(1)
  })

  it('stays failed when the stalled operation is acknowledged late', async () => {
    const { worker, q, failures } = await openQueue({ stallTimeoutMs: 100 })
    const stalled = q.enqueueSync({ kind: 'ping' }).catch((err: unknown) => err)
    await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 1000, interval: 5 })
    expect(await stalled).toBe(failures[0])

    worker.emit('message', {
      id: worker.sent[1].id,
      ok: true,
      result: 'late',
    } satisfies WorkerReply)
    await sleep(1)
    expect(() => q.enqueueAsync('s1', { kind: 'ping' })).toThrow(failures[0].message)
    await expect(q.enqueueSync({ kind: 'ping' })).rejects.toBe(failures[0])
    expect(failures).toHaveLength(1)
  })

  it('waits for a shutdown that takes longer than syncTimeoutMs while within the bound', async () => {
    const { worker, q, failures } = await openQueue({ stallTimeoutMs: 1000, syncTimeoutMs: 30 })
    const closing = q.close()
    await vi.waitFor(() => expect(worker.sent.map(m => m.op.kind)).toContain('shutdown'))
    await sleep(90)
    ack(
      worker,
      worker.sent.find(m => m.op.kind === 'shutdown')!
    )
    // Liveness witness: close() resolves after the late shutdown ACK.
    await expect(closing).resolves.toBeUndefined()
    expect(failures).toHaveLength(0)
  })

  it('keeps the bound after an earlier failure, so close() does not wait forever', async () => {
    const { worker, q, failures, terminateCalls } = await openQueue({ stallTimeoutMs: 100 })
    q.enqueueAsync('a', { kind: 'ping' })
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2))
    const hung = q.enqueueSync({ kind: 'ping' }).catch((err: unknown) => err)
    expect(worker.sent).toHaveLength(3)
    worker.emit('message', {
      id: worker.sent[1].id,
      ok: false,
      error: { code: 'SQLITE_FULL', message: 'database or disk is full' },
    } satisfies WorkerReply)
    // Liveness witness: the async failure is latched first.
    await vi.waitFor(() => expect(failures).toHaveLength(1))
    const started = Date.now()
    await expect(q.close()).rejects.toThrow(/database or disk is full/)
    expect(Date.now() - started).toBeLessThan(400)
    expect(terminateCalls()).toBe(1)
    expect(await hung).toBeInstanceOf(Error)
    expect(failures).toHaveLength(1)
  })
})
