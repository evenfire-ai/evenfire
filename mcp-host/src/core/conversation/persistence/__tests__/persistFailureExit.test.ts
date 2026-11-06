import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { exitOnPersistFailure, storeShutdownExitCode } from '../persistFailureExit'

// Runs the real factory, PersistQueue and exitOnPersistFailure in a child
// Node process and reads that process's exit code. The worker thread is a
// JS stand-in: it answers the open ping, acknowledges writes by appending them
// to a file (`slow` after 30 ms), fails the `fail` op, never answers `hang`
// and exits on `crash`.

const SRC = path.resolve(__dirname, '..', '..', '..', '..')
const HOOK = path.join(__dirname, 'fixtures', 'tsResolveHook.cjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const WORKER = `
const fs = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')
parentPort.on('message', msg => {
  const kind = msg.op.kind
  if (kind === 'ping') parentPort.postMessage({ id: msg.id, ok: true, result: null })
  if (kind === 'slow') {
    setTimeout(() => {
      fs.appendFileSync(workerData.dbPath, msg.op.value + '\\n')
      parentPort.postMessage({ id: msg.id, ok: true, result: null })
    }, 30)
  }
  if (kind === 'write') {
    fs.appendFileSync(workerData.dbPath, msg.op.value + '\\n')
    parentPort.postMessage({ id: msg.id, ok: true, result: null })
  }
  if (kind === 'fail') {
    const error = { code: 'SQLITE_CONSTRAINT', message: 'FOREIGN KEY constraint failed' }
    parentPort.postMessage({ id: msg.id, ok: false, error })
  }
  if (kind === 'crash') process.exit(3)
  if (kind === 'shutdown') {
    parentPort.postMessage({ id: msg.id, ok: true, result: null })
    process.exit(0)
  }
})
`

const CHILD = `
const path = require('node:path')
const [srcRoot, workerPath, dataPath, scenario] = process.argv.slice(2)
const persistence = path.join(srcRoot, 'core/conversation/persistence')
const { createConversationStore } = require(path.join(persistence, 'conversationStoreFactory.ts'))
const { exitOnPersistFailure, storeShutdownExitCode } = require(path.join(persistence, 'persistFailureExit.ts'))
// Mirrors main.ts: the graceful path marks the Host as shutting down, closes
// the store and exits with the code storeShutdownExitCode returns.
let shuttingDown = false
async function gracefulExit() {
  shuttingDown = true
  process.exit(await storeShutdownExitCode(() => handle.shutdown()))
}
const handle = createConversationStore({
  mode: 'sqlite',
  dbPath: dataPath,
  cacheSize: 10,
  syncTimeoutMs: 5000,
  asyncTimeoutMs: 50,
  // The slow backlog needs room above a loaded machine's ACK gap: 30 ms per
  // write, yet one full-suite run stopped it after 4 writes in 1.5 s, which
  // in this stand-in only the 300 ms bound can do. It still has to finish
  // past asyncTimeoutMs, the old close() budget.
  stallTimeoutMs: scenario === 'shutdown-slow-backlog' ? 5000 : 300,
  checkpointEveryWrites: 100,
  heartbeatMs: 60000,
  workerScriptPath: workerPath,
  onPersistFailure: exitOnPersistFailure(() => shuttingDown, {
    beforeExit: async () => console.log('PRE_EXIT_FLUSH'),
    beforeExitTimeoutMs: 1000,
  }),
})
const queue = handle.persistQueue
;(async () => {
  await queue.enqueueSync({ kind: 'write', value: 'first' })
  console.log('FIRST_WRITE_ACKED')
  if (scenario === 'alive') {
    queue.enqueueAsync('s1', { kind: 'write', value: 'second' })
    await handle.shutdown()
    console.log('SHUTDOWN_CLEAN')
    return
  }
  if (scenario === 'shutdown-slow-backlog') {
    for (let i = 0; i < 20; i++) queue.enqueueAsync('s1', { kind: 'slow', value: 'slow' + i })
    await gracefulExit()
    return
  }
  if (scenario === 'shutdown-wedged') {
    queue.enqueueAsync('s1', { kind: 'hang' })
    await gracefulExit()
    return
  }
  if (scenario === 'wedged') {
    queue.enqueueAsync('s1', { kind: 'hang' })
    setTimeout(() => {
      console.log('STILL_RUNNING')
      process.exit(0)
    }, 5000)
    return
  }
  queue.enqueueAsync('s1', { kind: scenario === 'async-write-failure' ? 'fail' : 'crash' })
  setTimeout(() => {
    console.log('STILL_RUNNING')
    process.exit(0)
  }, 5000)
})()
`

type Scenario =
  | 'alive'
  | 'async-write-failure'
  | 'worker-exit'
  | 'wedged'
  | 'shutdown-slow-backlog'
  | 'shutdown-wedged'

function runChild(scenario: Scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-failure-exit-'))
  roots.push(root)
  const worker = path.join(root, 'worker.cjs')
  const child = path.join(root, 'child.cjs')
  const data = path.join(root, 'writes.log')
  fs.writeFileSync(worker, WORKER)
  fs.writeFileSync(child, CHILD)
  const started = Date.now()
  const result = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-transform-types',
      '--require',
      HOOK,
      child,
      SRC,
      worker,
      data,
      scenario,
    ],
    { encoding: 'utf8', timeout: 20_000 }
  )
  const elapsedMs = Date.now() - started
  const writes = fs.existsSync(data)
    ? fs.readFileSync(data, 'utf8').split('\n').filter(Boolean)
    : []
  return { status: result.status, out: `${result.stdout}${result.stderr}`, writes, elapsedMs }
}

describe('exitOnPersistFailure in a Host process', () => {
  it('keeps the process running and persists writes while the worker is healthy', () => {
    const run = runChild('alive')
    expect(run.out).toContain('FIRST_WRITE_ACKED')
    expect(run.out).toContain('SHUTDOWN_CLEAN')
    expect(run.writes).toEqual(['first', 'second'])
    expect(run.status).toBe(0)
  })

  it('exits 1 when an async write fails', () => {
    const run = runChild('async-write-failure')
    expect(run.out).toContain('FIRST_WRITE_ACKED')
    expect(run.out).toContain('Conversation store can no longer persist writes')
    expect(run.out).toContain('PRE_EXIT_FLUSH')
    expect(run.out).not.toContain('STILL_RUNNING')
    expect(run.status).toBe(1)
  })

  it('exits 1 when the worker exits unexpectedly', () => {
    const run = runChild('worker-exit')
    expect(run.out).toContain('FIRST_WRITE_ACKED')
    expect(run.out).toContain('worker exited; writes are rejected')
    expect(run.out).toContain('Conversation store can no longer persist writes')
    expect(run.out).not.toContain('STILL_RUNNING')
    expect(run.status).toBe(1)
  })

  it('exits 1, bounded, when the worker stays alive but stops answering', () => {
    const run = runChild('wedged')
    expect(run.out).toContain('FIRST_WRITE_ACKED')
    expect(run.out).toContain('db worker made no progress')
    expect(run.out).toContain('"stallTimeoutMs":300')
    expect(run.out).toContain('PRE_EXIT_FLUSH')
    expect(run.out).not.toContain('STILL_RUNNING')
    expect(run.status).toBe(1)
    // 300 ms bound + 1 s flush deadline + process start-up.
    expect(run.elapsedMs).toBeLessThan(4000)
  })
})

describe('Host process exit on a graceful shutdown', () => {
  it('drains a slow backlog longer than asyncTimeoutMs and exits 0', () => {
    const run = runChild('shutdown-slow-backlog')
    expect(run.out).toContain('FIRST_WRITE_ACKED')
    // Liveness witness: every queued write reached the store.
    expect(run.writes, run.out).toEqual([
      'first',
      ...Array.from({ length: 20 }, (_, i) => `slow${i}`),
    ])
    expect(run.out).not.toContain('ConversationStore shutdown failed')
    expect(run.status, run.out).toBe(0)
  })

  it('exits 1 when the store cannot drain because the worker is wedged', () => {
    const run = runChild('shutdown-wedged')
    expect(run.out).toContain('FIRST_WRITE_ACKED')
    expect(run.out).toContain('ConversationStore shutdown failed; exiting with code 1')
    expect(run.out).toContain('db worker made no progress')
    expect(run.out).toContain('"stallTimeoutMs":300')
    expect(run.status).toBe(1)
    expect(run.elapsedMs).toBeLessThan(4000)
  })
})

describe('storeShutdownExitCode', () => {
  it('returns 0 when the store closes and 1 when closing rejects', async () => {
    // Liveness witness: a clean close is 0, so the 1 below comes from the rejection.
    await expect(storeShutdownExitCode(async () => undefined)).resolves.toBe(0)
    await expect(
      storeShutdownExitCode(async () => {
        throw new Error('async write failed (sessionKey=s1): disk I/O error')
      })
    ).resolves.toBe(1)
  })
})

describe('exitOnPersistFailure during shutdown', () => {
  it('does not exit while the Host is shutting down', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const beforeExit = vi.fn(async () => undefined)
    try {
      let shuttingDown = true
      const handler = exitOnPersistFailure(() => shuttingDown, {
        beforeExit,
        beforeExitTimeoutMs: 1000,
      })
      handler(new Error('db worker exited (code=1)'))
      expect(beforeExit).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()

      // Liveness witness: the same handler exits once shutdown is not running.
      shuttingDown = false
      handler(new Error('db worker exited (code=1)'))
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1))
      expect(beforeExit).toHaveBeenCalledOnce()
    } finally {
      exit.mockRestore()
    }
  })
})

describe('exitOnPersistFailure pre-exit flush', () => {
  function spyExit(events: string[]) {
    return vi.spyOn(process, 'exit').mockImplementation(code => {
      events.push(`exit ${code}`)
      return undefined as never
    })
  }

  it('flushes before exiting 1', async () => {
    const events: string[] = []
    const exit = spyExit(events)
    try {
      const handler = exitOnPersistFailure(() => false, {
        beforeExit: async () => {
          events.push('flush start')
          await new Promise(r => setTimeout(r, 20))
          events.push('flushed')
        },
        beforeExitTimeoutMs: 1000,
      })
      handler(new Error('async write failed'))
      // A second failure during the flush neither flushes nor exits again.
      handler(new Error('db worker exited (code=1)'))
      await vi.waitFor(() => expect(exit).toHaveBeenCalled())
      expect(events).toEqual(['flush start', 'flushed', 'exit 1'])
    } finally {
      exit.mockRestore()
    }
  })

  it('exits 1 when the flush hangs past the deadline', async () => {
    const events: string[] = []
    const exit = spyExit(events)
    try {
      const handler = exitOnPersistFailure(() => false, {
        beforeExit: () => {
          events.push('flush start')
          return new Promise<void>(() => undefined)
        },
        beforeExitTimeoutMs: 30,
      })
      const started = Date.now()
      handler(new Error('async write failed'))
      await vi.waitFor(() => expect(exit).toHaveBeenCalled())
      expect(Date.now() - started).toBeLessThan(500)
      expect(events).toEqual(['flush start', 'exit 1'])
    } finally {
      exit.mockRestore()
    }
  })

  it('exits 1 when the flush fails', async () => {
    const events: string[] = []
    const exit = spyExit(events)
    try {
      const handler = exitOnPersistFailure(() => false, {
        beforeExit: async () => {
          events.push('flush start')
          throw new Error('usage endpoint unreachable')
        },
        beforeExitTimeoutMs: 1000,
      })
      handler(new Error('async write failed'))
      await vi.waitFor(() => expect(exit).toHaveBeenCalled())
      expect(events).toEqual(['flush start', 'exit 1'])
    } finally {
      exit.mockRestore()
    }
  })
})
