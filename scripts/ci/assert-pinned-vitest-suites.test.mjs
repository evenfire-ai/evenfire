import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pinnedSuiteViolations } from './assert-pinned-vitest-suites.mjs'

const SCRIPT = fileURLToPath(new URL('./assert-pinned-vitest-suites.mjs', import.meta.url))
const PINNED = 'serve.agentRateLimit.test.ts'

function file(name, statuses, status = 'passed') {
  return {
    name: `/work/gfs-controller/src/api/${name}`,
    status,
    assertionResults: statuses.map((testStatus, index) => ({
      title: `t${index}`,
      status: testStatus,
    })),
  }
}

test('accepts a pinned file whose every test passed', () => {
  const report = { testResults: [file(PINNED, ['passed', 'passed']), file('other.test.ts', [])] }
  assert.deepEqual(pinnedSuiteViolations(report, [PINNED]), [])
})

test('rejects a pinned file whose tests were all skipped', () => {
  // The shape Vitest 4.1 writes when every describe in the file is
  // describe.skip: the FILE status is still "passed", so only the per-test
  // statuses reveal it.
  const report = { testResults: [file(PINNED, ['skipped', 'skipped'])] }
  assert.deepEqual(pinnedSuiteViolations(report, [PINNED]), [
    `${PINNED}: no test passed`,
    `${PINNED}: 2 test(s) did not pass (skipped)`,
  ])
})

test('rejects a pinned file whose file status is not passed', () => {
  const report = { testResults: [file(PINNED, ['passed'], 'skipped')] }
  assert.deepEqual(pinnedSuiteViolations(report, [PINNED]), [`${PINNED}: file status is skipped`])
})

test('rejects one skipped, pending or todo test next to passing ones', () => {
  for (const status of ['skipped', 'pending', 'todo']) {
    const report = { testResults: [file(PINNED, ['passed', status])] }
    assert.deepEqual(pinnedSuiteViolations(report, [PINNED]), [
      `${PINNED}: 1 test(s) did not pass (${status})`,
    ])
  }
})

test('rejects a failed pinned file', () => {
  const report = { testResults: [file(PINNED, ['passed', 'failed'], 'failed')] }
  assert.deepEqual(pinnedSuiteViolations(report, [PINNED]), [
    `${PINNED}: file status is failed`,
    `${PINNED}: 1 test(s) did not pass (failed)`,
  ])
})

test('rejects a pinned file that is missing or matched twice', () => {
  assert.deepEqual(
    pinnedSuiteViolations({ testResults: [file('other.test.ts', ['passed'])] }, [PINNED]),
    [`${PINNED}: expected exactly 1 file in the report, found 0`]
  )
  const twice = { testResults: [file(PINNED, ['passed']), file(`nested/${PINNED}`, ['passed'])] }
  assert.deepEqual(pinnedSuiteViolations(twice, [PINNED]), [
    `${PINNED}: expected exactly 1 file in the report, found 2`,
  ])
})

test('matches the whole file name, not a suffix of another name', () => {
  const report = { testResults: [file(`x${PINNED}`, ['passed'])] }
  assert.deepEqual(pinnedSuiteViolations(report, [PINNED]), [
    `${PINNED}: expected exactly 1 file in the report, found 0`,
  ])
})

test('rejects an empty pinned list and a report without testResults', () => {
  assert.deepEqual(pinnedSuiteViolations({ testResults: [] }, []), ['no pinned suites were given'])
  assert.deepEqual(pinnedSuiteViolations({}, [PINNED]), ['the report has no testResults array'])
})

test('the CLI exits 0 on a clean report and 1 with a message on a skipped one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-suites-'))
  try {
    const clean = join(dir, 'clean.json')
    const skipped = join(dir, 'skipped.json')
    writeFileSync(clean, JSON.stringify({ testResults: [file(PINNED, ['passed'])] }))
    writeFileSync(skipped, JSON.stringify({ testResults: [file(PINNED, ['skipped'])] }))

    const ok = spawnSync(process.execPath, [SCRIPT, clean, PINNED], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /serve\.agentRateLimit\.test\.ts ran and passed/)

    const bad = spawnSync(process.execPath, [SCRIPT, skipped, PINNED], { encoding: 'utf8' })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /pinned suite check: serve\.agentRateLimit\.test\.ts: no test passed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
