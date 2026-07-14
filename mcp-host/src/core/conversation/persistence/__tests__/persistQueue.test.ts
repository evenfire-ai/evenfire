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
})
