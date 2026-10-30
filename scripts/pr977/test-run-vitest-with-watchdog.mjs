import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (!scratchRoot || !path.isAbsolute(scratchRoot))
  throw new Error('CODEX_SCRATCH_ROOT must name the configured absolute scratch directory')
const taskScratchParent = path.join(scratchRoot, 'evenfire')
mkdirSync(taskScratchParent, { recursive: true })
const directory = mkdtempSync(path.join(taskScratchParent, 'pr977-watchdog-proof-'))
const here = path.dirname(fileURLToPath(import.meta.url))
const runner = path.join(here, 'run-vitest-with-watchdog.mjs')

function run(name, childSource, noProgressMs = 1000) {
  const progress = path.join(directory, `${name}.jsonl`)
  const status = path.join(directory, `${name}-status.json`)
  const result = spawnSync(
    process.execPath,
    [
      runner,
      '--maximum-runtime-ms=3000',
      `--no-progress-ms=${noProgressMs}`,
      `--progress=${progress}`,
      `--status=${status}`,
      '--',
      process.execPath,
      '-e',
      childSource,
    ],
    { encoding: 'utf8', timeout: 7000, env: process.env }
  )
  return { result, status: JSON.parse(readFileSync(status, 'utf8')) }
}

try {
  const completed = run('completed', 'process.exit(0)')
  assert.equal(completed.result.status, 0)
  assert.equal(completed.status.outcome, 'completed')

  const failed = run('failed', 'process.exit(7)')
  assert.equal(failed.result.status, 7, 'Vitest failures must propagate through the watchdog')
  assert.equal(failed.status.outcome, 'failed')
  assert.equal(failed.status.exitCode, 7)

  const stalled = run(
    'stalled',
    `require('node:fs').appendFileSync(process.env.PR977_PROGRESS_PATH, JSON.stringify({elapsedMs:1,event:'hook-started',activeFile:'appService.test.ts',activeCase:'fixture case',activeHook:'afterEach',lastCompletedOperation:'case-completed'})+'\\n'); setInterval(()=>{},1000)`,
    300
  )
  assert.equal(stalled.result.status, 124)
  assert.equal(stalled.status.outcome, 'watchdog-expired')
  assert.equal(stalled.status.reason, 'no-progress')
  assert.equal(stalled.status.lastProgress.activeHook, 'afterEach')
  assert.equal(stalled.status.lastProgress.lastCompletedOperation, 'case-completed')

  process.stdout.write(
    'Watchdog completion, failure propagation, and stalled-hook evidence passed.\n'
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
