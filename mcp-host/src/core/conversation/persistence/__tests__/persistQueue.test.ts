import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WorkerMessage, WorkerReply } from '../../../../db/worker/protocol'
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
    const q = new PersistQueue(worker, { syncTimeoutMs: 200, asyncTimeoutMs: 500 })
    const promise = q.enqueueSync({ kind: 'ping' })
    const sent = worker.sent[0]
    worker.emit('message', { id: sent.id, ok: true, result: 'pong' } satisfies WorkerReply)
    await expect(promise).resolves.toBe('pong')
  })

  it('rejects enqueueSync when worker replies with error', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, { syncTimeoutMs: 200, asyncTimeoutMs: 500 })
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
    const q = new PersistQueue(worker, { syncTimeoutMs: 30, asyncTimeoutMs: 30 })
    await expect(q.enqueueSync({ kind: 'ping' })).rejects.toThrow(/timeout/)
  })

  it('enqueueAsync preserves order per sessionKey', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, { syncTimeoutMs: 200, asyncTimeoutMs: 500 })
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
    const q = new PersistQueue(worker, { syncTimeoutMs: 200, asyncTimeoutMs: 500 })
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
    const q = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
    const promise = q.enqueueSync({ kind: 'ping' })
    worker.emit('exit', 137)
    await expect(promise).rejects.toThrow(/db worker exited/)
  })

  it('rejects async writes admitted after the worker exited instead of dropping them', async () => {
    const worker = new FakeWorker()
    const q = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
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
    const q = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
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

  it('calls onFailure once when the worker exits unexpectedly', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      onFailure: err => failures.push(err),
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

  it('does not call onFailure for the worker exit that follows a shutdown ACK', async () => {
    const worker = new FakeWorker()
    const failures: Error[] = []
    const exits: number[] = []
    const q = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      onFailure: err => failures.push(err),
      onExit: code => exits.push(code),
    })
    const closing = q.close()
    await new Promise(r => setImmediate(r))
    const shutdown = worker.sent.find(m => m.op.kind === 'shutdown')
    expect(shutdown).toBeDefined()
    worker.emit('message', { id: shutdown!.id, ok: true, result: null } satisfies WorkerReply)
    // FakeWorker.terminate() emits the exit.
    await closing
    // Liveness witness: the exit was observed.
    expect(exits).toEqual([0])
    expect(failures).toHaveLength(0)
  })

  it('waits for the worker shutdown ACK before terminating it', async () => {
    const worker = new FakeWorker()
    let terminateCalls = 0
    worker.terminate = () => {
      terminateCalls += 1
    }
    const q = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
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
    const q = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
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
    const q = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
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
    const q = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
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
