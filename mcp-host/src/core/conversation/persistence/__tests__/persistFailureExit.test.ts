import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Runs the real factory, PersistQueue and exitOnPersistFailure in a child
// Node process and reads that process's exit code. The worker thread is a
// JS stand-in: it acknowledges writes by appending them to a file, fails the
// `fail` op and exits on `crash`.

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
const { exitOnPersistFailure } = require(path.join(persistence, 'persistFailureExit.ts'))
const handle = createConversationStore({
  mode: 'sqlite',
  dbPath: dataPath,
  cacheSize: 10,
  syncTimeoutMs: 5000,
  asyncTimeoutMs: 5000,
  checkpointEveryWrites: 100,
  heartbeatMs: 60000,
  workerScriptPath: workerPath,
  onPersistFailure: exitOnPersistFailure(() => false),
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
  queue.enqueueAsync('s1', { kind: scenario === 'async-write-failure' ? 'fail' : 'crash' })
  setTimeout(() => {
    console.log('STILL_RUNNING')
    process.exit(0)
  }, 5000)
})()
`

function runChild(scenario: 'alive' | 'async-write-failure' | 'worker-exit') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-failure-exit-'))
  roots.push(root)
  const worker = path.join(root, 'worker.cjs')
  const child = path.join(root, 'child.cjs')
  const data = path.join(root, 'writes.log')
  fs.writeFileSync(worker, WORKER)
  fs.writeFileSync(child, CHILD)
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
  const writes = fs.existsSync(data)
    ? fs.readFileSync(data, 'utf8').split('\n').filter(Boolean)
    : []
  return { status: result.status, out: `${result.stdout}${result.stderr}`, writes }
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
})
