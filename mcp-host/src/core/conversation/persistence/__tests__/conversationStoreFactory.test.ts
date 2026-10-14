import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
})
