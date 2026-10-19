import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from '../../../../logger'
import { createConversationStore } from '../conversationStoreFactory'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function workerScript(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-factory-'))
  roots.push(root)
  const file = path.join(root, 'worker.cjs')
  fs.writeFileSync(file, body)
  return file
}

function waitFor<T>(register: (resolve: (v: T) => void) => void, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no callback within ${ms}ms`)), ms)
    register(v => {
      clearTimeout(timer)
      resolve(v)
    })
  })
}

describe('createConversationStore persist failure', () => {
  it('reports an unexpected exit of a real worker thread through onPersistFailure', async () => {
    const script = workerScript(`
      const { parentPort } = require('node:worker_threads')
      parentPort.on('message', msg => {
        if (msg.op.kind === 'ping') parentPort.postMessage({ id: msg.id, ok: true, result: 'pong' })
        if (msg.op.kind === 'crash') process.exit(3)
      })
    `)
    let onFailure: (err: Error) => void = () => {
      throw new Error('onPersistFailure fired before the test registered it')
    }
    const handle = createConversationStore({
      mode: 'sqlite',
      dbPath: path.join(path.dirname(script), 'state.db'),
      cacheSize: 10,
      syncTimeoutMs: 2000,
      asyncTimeoutMs: 2000,
      stallTimeoutMs: 30_000,
      checkpointEveryWrites: 100,
      heartbeatMs: 60_000,
      workerScriptPath: script,
      onPersistFailure: err => onFailure(err),
    })
    const queue = handle.persistQueue
    if (!queue) throw new Error('sqlite mode returned no persist queue')

    // Liveness witness: the live worker acknowledges a write.
    await expect(queue.enqueueSync({ kind: 'ping' })).resolves.toBe('pong')

    const failure = waitFor<Error>(resolve => {
      onFailure = resolve
    }, 5000)
    queue.enqueueAsync('s1', { kind: 'crash' } as never)
    await expect(failure).resolves.toMatchObject({ message: 'db worker exited (code=3)' })
    expect(() => queue.enqueueAsync('s1', { kind: 'ping' })).toThrow(/db worker exited/)
  })

  it('logs no error when the worker exits after a graceful shutdown', async () => {
    const script = workerScript(`
      const { parentPort } = require('node:worker_threads')
      parentPort.on('message', msg => {
        if (msg.op.kind === 'ping') parentPort.postMessage({ id: msg.id, ok: true, result: 'pong' })
        if (msg.op.kind === 'shutdown') {
          parentPort.postMessage({ id: msg.id, ok: true, result: { ok: true } })
          process.exit(0)
        }
      })
    `)
    const errors = vi.spyOn(logger, 'error')
    try {
      const failures: Error[] = []
      const handle = createConversationStore({
        mode: 'sqlite',
        dbPath: path.join(path.dirname(script), 'state.db'),
        cacheSize: 10,
        syncTimeoutMs: 2000,
        asyncTimeoutMs: 2000,
        stallTimeoutMs: 30_000,
        checkpointEveryWrites: 100,
        heartbeatMs: 60_000,
        workerScriptPath: script,
        onPersistFailure: err => failures.push(err),
      })
      const worker = handle.worker
      if (!worker || !handle.persistQueue) throw new Error('sqlite mode returned no worker')
      const exited = new Promise<number>(resolve => worker.once('exit', resolve))
      await expect(handle.persistQueue.enqueueSync({ kind: 'ping' })).resolves.toBe('pong')

      await handle.shutdown()
      // Liveness witness: the worker really exited after the shutdown ACK.
      await expect(exited).resolves.toBe(0)
      expect(failures).toHaveLength(0)
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})

describe('createConversationStore store identity', () => {
  it('logs the resolved database path once for a sqlite store', async () => {
    const script = workerScript(`
      const { parentPort } = require('node:worker_threads')
      parentPort.on('message', msg => {
        if (msg.op.kind === 'ping') parentPort.postMessage({ id: msg.id, ok: true, result: 'pong' })
        if (msg.op.kind === 'shutdown') {
          parentPort.postMessage({ id: msg.id, ok: true, result: { ok: true } })
          process.exit(0)
        }
      })
    `)
    const dbPath = path.join(path.dirname(script), 'state.db')
    const info = vi.spyOn(logger, 'info')
    try {
      const handle = createConversationStore({
        mode: 'sqlite',
        dbPath,
        cacheSize: 10,
        syncTimeoutMs: 2000,
        asyncTimeoutMs: 2000,
        stallTimeoutMs: 30_000,
        checkpointEveryWrites: 100,
        heartbeatMs: 60_000,
        workerScriptPath: script,
      })
      await expect(handle.persistQueue?.enqueueSync({ kind: 'ping' })).resolves.toBe('pong')
      const opened = info.mock.calls.filter(([, msg]) => msg === '[ConversationStore] opened')
      expect(opened).toEqual([[{ dbPath, mode: 'sqlite' }, '[ConversationStore] opened']])
      await handle.shutdown()
    } finally {
      info.mockRestore()
    }
  })

  it('logs the database path only after the worker answers its first operation', async () => {
    const script = workerScript(`
      const fs = require('node:fs')
      const path = require('node:path')
      const { parentPort, workerData } = require('node:worker_threads')
      const held = []
      parentPort.on('message', msg => {
        if (msg.op.kind === 'ping') {
          fs.writeFileSync(path.join(path.dirname(workerData.dbPath), 'ping-received'), '')
          held.push(msg.id)
        }
        if (msg.op.kind === 'release') {
          for (const id of held.splice(0)) parentPort.postMessage({ id, ok: true, result: 'pong' })
          parentPort.postMessage({ id: msg.id, ok: true, result: 'released' })
        }
        if (msg.op.kind === 'shutdown') {
          parentPort.postMessage({ id: msg.id, ok: true, result: { ok: true } })
          process.exit(0)
        }
      })
    `)
    const dbPath = path.join(path.dirname(script), 'state.db')
    const marker = path.join(path.dirname(script), 'ping-received')
    const info = vi.spyOn(logger, 'info')
    const opened = () => info.mock.calls.filter(([, msg]) => msg === '[ConversationStore] opened')
    try {
      const handle = createConversationStore({
        mode: 'sqlite',
        dbPath,
        cacheSize: 10,
        syncTimeoutMs: 5000,
        asyncTimeoutMs: 5000,
        stallTimeoutMs: 30_000,
        checkpointEveryWrites: 100,
        heartbeatMs: 60_000,
        workerScriptPath: script,
      })
      // Liveness witness: the factory's first operation reached the worker.
      await waitFor<void>(resolve => {
        const poll = setInterval(() => {
          if (fs.existsSync(marker)) {
            clearInterval(poll)
            resolve()
          }
        }, 5)
      }, 3000)
      expect(opened()).toEqual([])

      await expect(handle.persistQueue?.enqueueSync({ kind: 'release' } as never)).resolves.toBe(
        'released'
      )
      await waitFor<void>(resolve => {
        const poll = setInterval(() => {
          if (opened().length > 0) {
            clearInterval(poll)
            resolve()
          }
        }, 5)
      }, 3000)
      expect(opened()).toEqual([[{ dbPath, mode: 'sqlite' }, '[ConversationStore] opened']])
      await handle.shutdown()
    } finally {
      info.mockRestore()
    }
  })

  // Opening can outlast a write budget (worker spawn, migrations, recovery of
  // a large WAL), so the identity line must not depend on `syncTimeoutMs`.
  it('logs the database path when opening takes longer than the sync write timeout', async () => {
    const script = workerScript(`
      const { parentPort } = require('node:worker_threads')
      parentPort.on('message', msg => {
        if (msg.op.kind === 'ping') {
          setTimeout(() => parentPort.postMessage({ id: msg.id, ok: true, result: 'pong' }), 400)
        }
        if (msg.op.kind === 'shutdown') {
          parentPort.postMessage({ id: msg.id, ok: true, result: { ok: true } })
          process.exit(0)
        }
      })
    `)
    const dbPath = path.join(path.dirname(script), 'state.db')
    const info = vi.spyOn(logger, 'info')
    const errors = vi.spyOn(logger, 'error')
    const opened = () => info.mock.calls.filter(([, msg]) => msg === '[ConversationStore] opened')
    try {
      const handle = createConversationStore({
        mode: 'sqlite',
        dbPath,
        cacheSize: 10,
        syncTimeoutMs: 100,
        asyncTimeoutMs: 100,
        stallTimeoutMs: 30_000,
        checkpointEveryWrites: 100,
        heartbeatMs: 60_000,
        workerScriptPath: script,
      })
      await waitFor<void>(resolve => {
        const poll = setInterval(() => {
          if (opened().length > 0) {
            clearInterval(poll)
            resolve()
          }
        }, 5)
      }, 3000)
      expect(opened()).toEqual([[{ dbPath, mode: 'sqlite' }, '[ConversationStore] opened']])
      expect(
        errors.mock.calls.filter(([, msg]) => msg === '[ConversationStore] database did not open')
      ).toEqual([])
      await handle.shutdown()
    } finally {
      info.mockRestore()
      errors.mockRestore()
    }
  })

  it('logs no database path when the worker exits before opening the database', async () => {
    const script = workerScript(`process.exit(1)`)
    const info = vi.spyOn(logger, 'info')
    const errors = vi.spyOn(logger, 'error')
    try {
      const failure = waitFor<Error>(resolve => {
        createConversationStore({
          mode: 'sqlite',
          dbPath: path.join(path.dirname(script), 'state.db'),
          cacheSize: 10,
          syncTimeoutMs: 2000,
          asyncTimeoutMs: 2000,
          stallTimeoutMs: 30_000,
          checkpointEveryWrites: 100,
          heartbeatMs: 60_000,
          workerScriptPath: script,
          onPersistFailure: resolve,
        })
      }, 5000)
      // Liveness witness: the factory saw the worker exit.
      await expect(failure).resolves.toMatchObject({ message: 'db worker exited (code=1)' })
      await waitFor<void>(resolve => {
        const poll = setInterval(() => {
          if (
            errors.mock.calls.some(([, msg]) => msg === '[ConversationStore] database did not open')
          ) {
            clearInterval(poll)
            resolve()
          }
        }, 5)
      }, 3000)
      expect(info.mock.calls.filter(([, msg]) => msg === '[ConversationStore] opened')).toEqual([])
    } finally {
      info.mockRestore()
      errors.mockRestore()
    }
  })

  it('logs no database path for a memory store', () => {
    const info = vi.spyOn(logger, 'info')
    try {
      const handle = createConversationStore({
        mode: 'memory',
        cacheSize: 10,
        syncTimeoutMs: 2000,
        asyncTimeoutMs: 2000,
        stallTimeoutMs: 30_000,
        checkpointEveryWrites: 100,
        heartbeatMs: 60_000,
      })
      // Liveness witness: the factory built the memory store.
      expect(handle.mode).toBe('memory')
      expect(info.mock.calls.filter(([, msg]) => msg === '[ConversationStore] opened')).toEqual([])
    } finally {
      info.mockRestore()
    }
  })
})
