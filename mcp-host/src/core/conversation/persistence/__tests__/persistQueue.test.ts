import { describe, expect, it, vi } from 'vitest'
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

describe('PersistQueue maintenance shutdown', () => {
  it('waits for unkeyed accepted writes, then DB-close ACK and actual worker exit', async () => {
    const worker = new FakeWorker()
    const terminate = vi.spyOn(worker, 'terminate')
    const queue = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
    const write = queue.enqueueSync({
      kind: 'update_session_title',
      sessionId: 's1',
      title: 'accepted',
    })
    const closing = queue.close()
    await expect(queue.enqueueSync({ kind: 'ping' })).rejects.toThrow('closed')
    await new Promise(resolve => setImmediate(resolve))
    expect(worker.sent.map(message => message.op.kind)).toEqual(['update_session_title'])
    worker.emit('message', { id: worker.sent[0].id, ok: true, result: { ok: true } })
    await write
    await new Promise(resolve => setImmediate(resolve))
    expect(worker.sent.map(message => message.op.kind)).toEqual([
      'update_session_title',
      'shutdown',
    ])
    let finished = false
    void closing.then(() => {
      finished = true
    })
    worker.emit('message', { id: worker.sent[1].id, ok: true, result: { closed: true } })
    await new Promise(resolve => setImmediate(resolve))
    expect(finished).toBe(false)
    expect(terminate).not.toHaveBeenCalled()
    worker.emit('exit', 0)
    await closing
    expect(finished).toBe(true)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('drains both accepted ordered writes before sending shutdown', async () => {
    const worker = new FakeWorker()
    const queue = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
    queue.enqueueAsync('s1', { kind: 'ping' })
    queue.enqueueAsync('s1', { kind: 'ping' })
    const closing = queue.close()
    expect(() => queue.enqueueAsync('s2', { kind: 'ping' })).toThrow('closed')
    await new Promise(resolve => setImmediate(resolve))
    expect(worker.sent).toHaveLength(1)
    worker.emit('message', { id: worker.sent[0].id, ok: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(worker.sent).toHaveLength(2)
    worker.emit('message', { id: worker.sent[1].id, ok: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(worker.sent[2].op.kind).toBe('shutdown')
    worker.emit('message', { id: worker.sent[2].id, ok: true, result: { closed: true } })
    worker.emit('exit', 0)
    await closing
  })

  it('never turns a failed accepted async write into a successful drain receipt', async () => {
    const worker = new FakeWorker()
    const queue = new PersistQueue(worker, { syncTimeoutMs: 500, asyncTimeoutMs: 500 })
    queue.enqueueAsync('s1', { kind: 'update_session_title', sessionId: 's1', title: 'accepted' })
    await new Promise(resolve => setImmediate(resolve))
    const draining = queue.drain()
    worker.emit('message', {
      id: worker.sent[0].id,
      ok: false,
      error: { code: 'SQLITE_IOERR', message: 'write failed' },
    })
    await expect(draining).rejects.toThrow('write failed')
    worker.emit('exit', 0)
    await expect(queue.close()).rejects.toThrow('write failed')
  })

  it('rejects pending calls immediately on a fatal worker reply and closes new admission', async () => {
    const worker = new FakeWorker()
    const onTransportError = vi.fn()
    const queue = new PersistQueue(worker, {
      syncTimeoutMs: 500,
      asyncTimeoutMs: 500,
      onTransportError,
    })
    const pending = queue.enqueueSync({ kind: 'ping' })
    worker.emit('message', {
      id: '__fatal__',
      ok: false,
      error: { code: 'WRITER_FENCE_LOST', message: 'writer stopped' },
    })
    await expect(pending).rejects.toThrow('writer stopped')
    await expect(queue.enqueueSync({ kind: 'ping' })).rejects.toThrow('closed')
    expect(onTransportError).toHaveBeenCalledTimes(1)
    worker.emit('exit', 1)
    await expect(queue.close()).rejects.toThrow('writer stopped')
  })

  it('contains a worker without shutdown ACK and reports failure instead of quiescence', async () => {
    const worker = new FakeWorker()
    const terminate = vi.spyOn(worker, 'terminate')
    const queue = new PersistQueue(worker, { syncTimeoutMs: 20, asyncTimeoutMs: 20 })
    await expect(queue.close()).rejects.toThrow('timeout')
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})
