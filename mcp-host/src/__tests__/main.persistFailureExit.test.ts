import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MCP_HOST_ROOT, compileSources } from '../db/worker/__tests__/compileSources'

// Drives the real compiled main.js (dev mode, SQLite store, real DB worker
// thread) and reads its exit code. The only test-side change is a preload
// that withholds the worker's `shutdown` message or terminates the worker on
// SIGUSR2; main.ts's shutdown flag, persist-failure handler and final
// process.exit run as in production.

const PRELOAD = path.join(__dirname, 'fixtures', 'dbWorkerControl.cjs')
const STALL_TIMEOUT_MS = 1000
const CHILD_DEADLINE_MS = 15_000

let tmpRoot: string
let mainScript: string

interface ChildRun {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
}

function runHost(
  control: 'withhold-shutdown' | 'terminate-on-sigusr2',
  signal: 'SIGTERM' | 'SIGUSR2',
  readyMarker: string
): Promise<ChildRun> {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'host-'))
  const child = spawn(process.execPath, ['--require', PRELOAD, mainScript], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      NODE_ENV: 'test',
      CLERUM_DEV_MODE: 'true',
      CLERUM_ENABLE_AUTH: 'false',
      OPENAI_API_KEY: 'sk-test-not-used',
      CLERUM_SESSION_STORE: 'sqlite',
      CLERUM_SESSION_DB_PATH: path.join(home, 'state.db'),
      CLERUM_SERVER_PORT: '0',
      CLERUM_MEMORY_WORKSPACE_PATH: path.join(home, 'workspace'),
      CLERUM_DB_PERSIST_SYNC_TIMEOUT_MS: '500',
      CLERUM_DB_WORKER_STALL_TIMEOUT_MS: String(STALL_TIMEOUT_MS),
      DB_WORKER_CONTROL: control,
    },
  })
  return new Promise(resolve => {
    let output = ''
    let signalled = false
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (
        !signalled &&
        output.includes('[ConversationStore] opened') &&
        output.includes(readyMarker)
      ) {
        signalled = true
        child.kill(signal)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const deadline = setTimeout(() => {
      output += `\nTEST_DEADLINE_KILLED after ${CHILD_DEADLINE_MS}ms (signalled=${signalled})\n`
      child.kill('SIGKILL')
    }, CHILD_DEADLINE_MS)
    child.on('exit', (code, exitSignal) => {
      clearTimeout(deadline)
      resolve({ code, signal: exitSignal, output })
    })
  })
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'main-persist-exit-'))
  fs.symlinkSync(path.join(MCP_HOST_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'))
  ;[mainScript] = compileSources(['main.ts', 'db/worker/dbWorker.ts'], path.join(tmpRoot, 'dist'))
}, 120_000)

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('main.ts persist-failure exit wiring (real entrypoint)', () => {
  it('exits 1 when the store cannot close during a graceful shutdown', async () => {
    // Signalled only once main.ts has installed its SIGTERM handler; before
    // that, the default action would kill the child.
    const run = await runHost('withhold-shutdown', 'SIGTERM', 'PRELOAD_SIGTERM_HANDLER_READY')

    // Witnesses: the real store opened, the preload engaged, and the
    // progress bound fired inside the shutdown window.
    expect(run.output, run.output).toContain('[ConversationStore] opened')
    expect(run.output, run.output).toContain('PRELOAD_SIGTERM_HANDLER_READY')
    expect(run.output, run.output).toContain('PRELOAD_WITHHELD_SHUTDOWN')
    expect(run.output, run.output).toContain('db worker made no progress')
    expect(run.output, run.output).toContain(
      'ConversationStore shutdown failed; exiting with code 1'
    )
    // The in-service handler stays silent while shutdown owns the exit.
    expect(run.output, run.output).not.toContain('Conversation store can no longer persist writes')
    expect({ code: run.code, signal: run.signal }).toEqual({ code: 1, signal: null })
  }, 30_000)

  it('exits 1 when the DB worker exits while the Host is serving', async () => {
    // The preload installs the SIGUSR2 handler before main.ts runs.
    const run = await runHost('terminate-on-sigusr2', 'SIGUSR2', 'MCP Host running in dev mode')

    expect(run.output, run.output).toContain('[ConversationStore] opened')
    expect(run.output, run.output).toContain('PRELOAD_TERMINATING_DB_WORKER')
    expect(run.output, run.output).toContain(
      '[ConversationStore] worker exited; writes are rejected'
    )
    expect(run.output, run.output).toContain(
      '[Main] Conversation store can no longer persist writes; exiting with code 1'
    )
    expect({ code: run.code, signal: run.signal }).toEqual({ code: 1, signal: null })
  }, 30_000)
})
