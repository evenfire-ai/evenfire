import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CronScheduler } from '../agent/cronScheduler'
import type { CronJobRecord } from '../db/cronJobs'
import { insertCronJob } from '../db/cronJobs'
import { runMigrations } from '../db/migrate'
import { MCP_HOST_ROOT, compileSources } from '../db/worker/__tests__/compileSources'
import { MessageQueue } from '../queue/messageQueue'

// Worker order uses the same compiled-main harness as
// main.persistFailureExit.test.ts. The drain lines are a separate witness:
// a production-shaped boot (background reconciliation) must not call
// drainAdmissions or drainForShutdown before the catch-up claim, even when
// an empty admission set would return immediately.

const WORKER_PRELOAD = path.join(__dirname, 'fixtures', 'dbWorkerControl.cjs')
const CHILD_DEADLINE_MS = 20_000

let tmpRoot: string
let mainScript: string
let drainPreload: string

interface ChildRun {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
  dbPath: string
}

function cronRow(id: string, schedule: string): CronJobRecord {
  return {
    id,
    name: id,
    schedule,
    task: 'check the deploy',
    enabled: true,
    nextRunAt: 1,
    lastRunAt: null,
    createdAt: 1,
    createdBy: null,
    origin: null,
    provider: null,
  }
}

function seedCron(dbPath: string, rows: CronJobRecord[]): void {
  const db = new Database(dbPath)
  try {
    runMigrations(db)
    for (const row of rows) insertCronJob(db, row)
  } finally {
    db.close()
  }
}

function readCron(dbPath: string, id: string): { enabled: number; next_run_at: number | null } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT enabled, next_run_at FROM cron_jobs WHERE id = ?').get(id) as
      | { enabled: number; next_run_at: number | null }
      | undefined
    if (!row) throw new Error(`cron row ${id} is missing`)
    return row
  } finally {
    db.close()
  }
}

function countPosts(output: string, kind: string): number {
  return output.split('\n').filter(line => line === `PRELOAD_POST ${kind}`).length
}

function runHost(
  extra: {
    env?: Record<string, string>
    seed?: (dbPath: string) => void
    readyWhen?: (output: string) => boolean
    requireStoreOpened?: boolean
  } = {}
): Promise<ChildRun> {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'host-'))
  const dbPath = path.join(home, 'state.db')
  extra.seed?.(dbPath)
  const child = spawn(
    process.execPath,
    ['--require', WORKER_PRELOAD, '--require', drainPreload, mainScript],
    {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        NODE_ENV: 'test',
        CLERUM_DEV_MODE: 'true',
        CLERUM_ENABLE_AUTH: 'false',
        OPENAI_API_KEY: 'sk-test-not-used',
        CLERUM_SESSION_STORE: 'sqlite',
        CLERUM_SESSION_DB_PATH: dbPath,
        CLERUM_SERVER_PORT: '0',
        CLERUM_MEMORY_WORKSPACE_PATH: path.join(home, 'workspace'),
        CLERUM_DB_PERSIST_SYNC_TIMEOUT_MS: '500',
        CLERUM_DB_WORKER_STALL_TIMEOUT_MS: '1000',
        DB_WORKER_CONTROL: 'record-ops',
        ...extra.env,
      },
    }
  )
  const readyWhen =
    extra.readyWhen ?? ((output: string) => output.includes('PRELOAD_SIGTERM_HANDLER_READY'))
  return new Promise(resolve => {
    let output = ''
    let signalled = false
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const opened =
        extra.requireStoreOpened === false || output.includes('[ConversationStore] opened')
      if (!signalled && opened && readyWhen(output)) {
        signalled = true
        child.kill('SIGTERM')
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
      resolve({ code, signal: exitSignal, output, dbPath })
    })
  })
}

function liveTimerCount(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>
): number {
  const cleared = new Set(clearTimeoutSpy.mock.calls.map((call: readonly unknown[]) => call[0]))
  let live = 0
  setTimeoutSpy.mock.results.forEach((result: { type: string; value?: unknown }) => {
    if (result.type === 'return' && !cleared.has(result.value)) live += 1
  })
  return live
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'main-cron-boot-'))
  fs.symlinkSync(path.join(MCP_HOST_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'))
  drainPreload = path.join(tmpRoot, 'drainProbe.cjs')
  fs.writeFileSync(
    drainPreload,
    [
      "const Module = require('module')",
      "const path = require('path')",
      'const originalRequire = Module.prototype.require',
      'let patched = false',
      'Module.prototype.require = function (id) {',
      '  const exported = originalRequire.apply(this, arguments)',
      "  if (patched || !exported || typeof exported !== 'object') return exported",
      '  let filename = ""',
      '  try { filename = Module._resolveFilename(id, this) } catch { return exported }',
      "  if (!filename.endsWith(path.sep + 'mcp' + path.sep + 'authoritativeFleet.js')) return exported",
      '  const Coordinator = exported.AuthoritativeMcpFleetCoordinator',
      "  if (typeof Coordinator !== 'function') return exported",
      '  patched = true',
      '  function Wrapped(...args) {',
      "    process.stdout.write('PRELOAD_FLEET_BACKGROUND ' + (args[2] === true) + '\\n')",
      '    return new Coordinator(...args)',
      '  }',
      '  Wrapped.prototype = Coordinator.prototype',
      '  Object.setPrototypeOf(Wrapped, Coordinator)',
      '  exported.AuthoritativeMcpFleetCoordinator = Wrapped',
      "  for (const name of ['drainAdmissions', 'drainForShutdown']) {",
      '    const original = Coordinator.prototype[name]',
      "    if (typeof original !== 'function') {",
      "      process.stdout.write('PRELOAD_DRAIN_MISSING ' + name + '\\n')",
      '      continue',
      '    }',
      '    Coordinator.prototype[name] = function (...args) {',
      "      process.stdout.write('PRELOAD_DRAIN ' + name + '\\n')",
      '      return original.apply(this, args)',
      '    }',
      '  }',
      '  return exported',
      '}',
      '',
    ].join('\n')
  )
  ;[mainScript] = compileSources(['main.ts', 'db/worker/dbWorker.ts'], path.join(tmpRoot, 'dist'))
}, 120_000)

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('stop then start', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('leaves the live timer count at 0', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const now = Date.parse('2026-11-25T07:59:30Z')
    vi.setSystemTime(now)
    const queue = new MessageQueue()
    vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
    const row = cronRow('later', '0 */8 * * *')
    row.nextRunAt = Math.floor(now / 1000) + 120
    const store = {
      load: async () => [{ ...row }],
      insert: async () => {
        throw new Error('insert was called')
      },
      delete: async () => {
        throw new Error('delete was called')
      },
      read: async () => null,
      claim: async () => {
        throw new Error('claim was called')
      },
      setSchedule: async () => undefined,
      setLastRun: async () => {
        throw new Error('setLastRun was called')
      },
    }
    const scheduler = new CronScheduler(queue, {
      store,
      now: () => Date.now(),
      allowEnabledJobs: true,
    })

    await scheduler.loadFromStore()
    scheduler.start()
    expect(liveTimerCount(setTimeoutSpy, clearTimeoutSpy)).toBe(1)

    scheduler.stop()
    scheduler.start()
    expect(liveTimerCount(setTimeoutSpy, clearTimeoutSpy)).toBe(0)
  })
})

describe('main cron boot', () => {
  it.each(['sqlite', 'dual'] as const)(
    'loads cron jobs after bootstrap and before the dev RPC listen (%s)',
    async mode => {
      const run = await runHost({
        env: { CLERUM_SESSION_STORE: mode },
        seed: dbPath => {
          seedCron(dbPath, [cronRow('due-1', '* * * * *'), cronRow('bad-1', 'not-a-cron')])
        },
      })

      const reap = run.output.indexOf('PRELOAD_POST reap_processing_sessions')
      const approvals = run.output.indexOf('PRELOAD_POST load_all_pending_approvals')
      const load = run.output.indexOf('PRELOAD_POST load_cron_jobs')
      const rpc = run.output.indexOf('RPC server listening')
      const claim = run.output.indexOf('PRELOAD_POST claim_cron_job')
      const drain = run.output.indexOf('PRELOAD_DRAIN drainForShutdown')
      const admit = run.output.indexOf('PRELOAD_DRAIN drainAdmissions')
      const invalidDisable = run.output.indexOf('PRELOAD_POST set_cron_schedule')
      const started = run.output.indexOf('Starting scheduler')
      const stoppedScheduler = run.output.indexOf('Stopping scheduler')
      const stoppedAgent = run.output.indexOf('Stopping agent')

      expect(reap, run.output).toBeGreaterThan(-1)
      expect(approvals, run.output).toBeGreaterThan(reap)
      expect(load, run.output).toBeGreaterThan(approvals)
      expect(rpc, run.output).toBeGreaterThan(load)
      expect(run.output, run.output).toContain('PRELOAD_FLEET_BACKGROUND true')
      expect(claim, run.output).toBeGreaterThan(load)
      expect(countPosts(run.output, 'claim_cron_job'), run.output).toBe(1)
      expect(drain, run.output).toBeGreaterThan(claim)
      expect(admit, run.output).toBeGreaterThan(claim)
      expect(run.output, run.output).not.toContain('PRELOAD_DRAIN_MISSING')
      expect(invalidDisable, run.output).toBeGreaterThan(-1)
      expect(invalidDisable, run.output).toBeLessThan(started)
      expect(stoppedScheduler, run.output).toBeGreaterThan(-1)
      expect(stoppedScheduler, run.output).toBeLessThan(stoppedAgent)
      expect(readCron(run.dbPath, 'bad-1')).toEqual({ enabled: 0, next_run_at: null })
      expect({ code: run.code, signal: run.signal }, run.output).toEqual({ code: 0, signal: null })
    },
    40_000
  )

  it('persists enabled=0 before start when stateless cron management is unset', async () => {
    const run = await runHost({
      env: {
        CLERUM_STATELESS_LIFECYCLE: 'true',
        CLERUM_POD_UID: 'fixture-pod-uid',
        MCP_HOST_GATEWAY_URL: 'https://example.invalid/gateway',
        MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_ENABLED: 'false',
      },
      seed: dbPath => {
        seedCron(dbPath, [cronRow('due-1', '* * * * *')])
      },
    })

    const disable = run.output.indexOf('PRELOAD_POST set_cron_schedule')
    const started = run.output.indexOf('Starting scheduler')
    expect(disable, run.output).toBeGreaterThan(-1)
    expect(started, run.output).toBeGreaterThan(disable)
    expect(countPosts(run.output, 'claim_cron_job'), run.output).toBe(0)
    expect(countPosts(run.output, 'set_cron_schedule'), run.output).toBe(1)
    expect(readCron(run.dbPath, 'due-1')).toEqual({ enabled: 0, next_run_at: null })
    expect({ code: run.code, signal: run.signal }, run.output).toEqual({ code: 0, signal: null })
  }, 40_000)

  it('does not load cron jobs when the session store is memory', async () => {
    const run = await runHost({
      env: { CLERUM_SESSION_STORE: 'memory' },
      requireStoreOpened: false,
    })

    expect(run.output, run.output).not.toContain('PRELOAD_POST load_cron_jobs')
    expect(run.output, run.output).toContain('RPC server listening')
    expect({ code: run.code, signal: run.signal }, run.output).toEqual({ code: 0, signal: null })
  }, 40_000)
})
