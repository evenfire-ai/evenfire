import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pinnedCaseViolations, pinnedSuiteViolations } from './assert-pinned-vitest-suites.mjs'

const SCRIPT = fileURLToPath(new URL('./assert-pinned-vitest-suites.mjs', import.meta.url))
const PINNED = 'serve.agentRateLimit.test.ts'
const CASE_SUITE = 'server.security.test.ts'
const CASE_NAME = 'provider twin critical witness'

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

function caseFile(names, status = 'passed', fileStatus = 'passed') {
  return {
    name: `/work/provider/${CASE_SUITE}`,
    status: fileStatus,
    assertionResults: names.map((fullName, index) => ({
      title: `case ${index}`,
      fullName,
      status,
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

test('case pins reject a lost critical case that leaves the file checker green', () => {
  const manifest = [
    { suite: CASE_SUITE, fullName: CASE_NAME },
    { suite: CASE_SUITE, fullName: 'other critical witness' },
  ]
  const report = { testResults: [caseFile(['other critical witness', 'unrelated test'])] }

  assert.deepEqual(pinnedSuiteViolations(report, [CASE_SUITE]), [])
  assert.deepEqual(pinnedCaseViolations(report, manifest), [
    `${CASE_SUITE} :: ${CASE_NAME}: expected exactly 1 matching case, found 0`,
  ])
})

test('case pins use the whole fullName and reject duplicates and non-passed cases', () => {
  const manifest = [{ suite: CASE_SUITE, fullName: CASE_NAME }]
  const renamed = {
    testResults: [caseFile([`${CASE_NAME} with different behavior`])],
  }
  assert.deepEqual(pinnedCaseViolations(renamed, manifest), [
    `${CASE_SUITE} :: ${CASE_NAME}: expected exactly 1 matching case, found 0`,
  ])

  const duplicate = { testResults: [caseFile([CASE_NAME, CASE_NAME])] }
  assert.deepEqual(pinnedCaseViolations(duplicate, manifest), [
    `${CASE_SUITE} :: ${CASE_NAME}: expected exactly 1 matching case, found 2`,
  ])

  const skipped = {
    testResults: [
      {
        name: `/work/provider/${CASE_SUITE}`,
        status: 'passed',
        assertionResults: [
          { fullName: CASE_NAME, status: 'skipped' },
          { fullName: 'other', status: 'passed' },
        ],
      },
    ],
  }
  assert.deepEqual(pinnedCaseViolations(skipped, manifest), [
    `${CASE_SUITE}: 1 test(s) did not pass (skipped) [pinned cases]`,
  ])

  const failed = {
    testResults: [
      {
        name: `/work/provider/${CASE_SUITE}`,
        status: 'failed',
        assertionResults: [
          { fullName: CASE_NAME, status: 'failed' },
          { fullName: 'other', status: 'passed' },
        ],
      },
    ],
  }
  assert.deepEqual(pinnedCaseViolations(failed, manifest), [
    `${CASE_SUITE}: file status is failed [pinned cases]`,
    `${CASE_SUITE}: 1 test(s) did not pass (failed) [pinned cases]`,
  ])
})

test('case pins reject malformed and duplicate manifests', () => {
  assert.deepEqual(pinnedCaseViolations({ testResults: [] }, []), [
    'the case manifest is empty or not an array',
  ])
  assert.deepEqual(pinnedCaseViolations({ testResults: [] }, {}), [
    'the case manifest is empty or not an array',
  ])

  const invalidEntries = [null, { fullName: CASE_NAME }, { suite: CASE_SUITE }]
  assert.deepEqual(pinnedCaseViolations({ testResults: [] }, invalidEntries), [
    'case 0: entry must be an object',
    'case 1: suite must be a non-empty string',
    'case 2: fullName must be a non-empty string',
  ])

  const duplicatePin = [
    { suite: CASE_SUITE, fullName: CASE_NAME },
    { suite: CASE_SUITE, fullName: CASE_NAME },
  ]
  const report = { testResults: [caseFile([CASE_NAME])] }
  assert.deepEqual(pinnedCaseViolations(report, duplicatePin), [
    `case 1: duplicate pin ${CASE_SUITE} :: ${CASE_NAME}`,
  ])
})

test('case pins keep exact suite paths and reject reports without test results', () => {
  const manifest = [{ suite: CASE_SUITE, fullName: CASE_NAME }]
  const wrongPath = {
    testResults: [
      {
        name: `/work/provider/x${CASE_SUITE}`,
        status: 'passed',
        assertionResults: [{ fullName: CASE_NAME, status: 'passed' }],
      },
    ],
  }
  assert.deepEqual(pinnedCaseViolations(wrongPath, manifest), [
    `${CASE_SUITE}: expected exactly 1 file in the report, found 0 [pinned cases]`,
  ])
  assert.deepEqual(pinnedCaseViolations({}, manifest), ['the report has no testResults array'])
})

test('the case CLI exits 0 on a clean report and 1 when a critical case is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-cases-'))
  try {
    const reportPath = join(dir, 'report.json')
    const manifestPath = join(dir, 'manifest.json')
    const manifest = [{ suite: CASE_SUITE, fullName: CASE_NAME }]
    writeFileSync(
      reportPath,
      JSON.stringify({ testResults: [caseFile([CASE_NAME, 'other test'])] })
    )
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const ok = spawnSync(process.execPath, [SCRIPT, '--cases', reportPath, manifestPath], {
      encoding: 'utf8',
    })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /pinned case check: .* ran and passed/)

    writeFileSync(reportPath, JSON.stringify({ testResults: [caseFile(['other test'])] }))
    const missing = spawnSync(process.execPath, [SCRIPT, '--cases', reportPath, manifestPath], {
      encoding: 'utf8',
    })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /expected exactly 1 matching case, found 0/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
