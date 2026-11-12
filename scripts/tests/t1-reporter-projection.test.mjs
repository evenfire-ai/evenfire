import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const projector = path.join(root, 'scripts/e2e/t1-reporter-projection.py')
const omittedText = 'synthetic-omitted-free-text-marker'

function scratch() {
  return mkdtempSync(path.join(process.env.CODEX_SCRATCH_ROOT || tmpdir(), 't1-projection-'))
}

function reporter(dir) {
  const packageRoot = path.join(dir, 'control-api')
  const report = {
    success: false,
    numTotalTestSuites: 3,
    numPassedTestSuites: 1,
    numFailedTestSuites: 2,
    numPendingTestSuites: 0,
    numTotalTests: 3,
    numPassedTests: 1,
    numFailedTests: 1,
    numPendingTests: 0,
    testResults: [
      {
        name: path.join(packageRoot, 'test/a.realPostgres.integration.test.ts'),
        status: 'failed',
        startTime: 1000,
        endTime: 1250,
        message: '',
        assertionResults: [
          { ancestorTitles: ['a'], title: 'passes', status: 'passed', duration: 12, failureMessages: [] },
          {
            ancestorTitles: ['a'],
            title: 'fails',
            status: 'failed',
            duration: 30,
            failureMessages: [`AssertionError: ${omittedText}`, `stack ${omittedText}`],
          },
        ],
      },
      {
        name: path.join(packageRoot, 'test/b.realPostgres.integration.test.ts'),
        status: 'failed',
        startTime: 2000,
        endTime: 2010,
        message: `beforeAll failed: ${omittedText}`,
        assertionResults: [],
      },
    ],
  }
  const file = path.join(dir, 'reporter.json')
  writeFileSync(file, JSON.stringify(report))
  return { file, packageRoot }
}

function run(args) {
  return spawnSync('python3', [projector, ...args], { encoding: 'utf8' })
}

test('projection keeps files, tests, statuses and counters without free text', () => {
  const dir = scratch()
  const { file, packageRoot } = reporter(dir)
  const out = path.join(dir, 'evidence', 'logs', 't1-control-api-isolated.results.json')
  const result = run([file, packageRoot, 'control-api', 'isolated', out])
  assert.equal(result.status, 0, result.stderr)
  const raw = readFileSync(out, 'utf8')
  assert.ok(!raw.includes(omittedText), 'free-text messages must not reach the evidence')
  const projection = JSON.parse(raw)
  assert.equal(projection.schema, 't1-reporter-projection/v1')
  assert.equal(projection.package, 'control-api')
  assert.equal(projection.lane, 'isolated')
  assert.equal(projection.counters.numFailedTests, 1)
  assert.deepEqual(
    projection.files.map(f => [f.file, f.status, f.durationMs, f.fileMessageOmitted, f.tests.length]),
    [
      ['test/a.realPostgres.integration.test.ts', 'failed', 250, false, 2],
      ['test/b.realPostgres.integration.test.ts', 'failed', 10, true, 0],
    ],
  )
  assert.deepEqual(
    projection.files[0].tests.map(t => [t.title, t.status, t.failureMessageCount]),
    [
      ['passes', 'passed', 0],
      ['fails', 'failed', 2],
    ],
  )
})

test('projection fails and writes nothing when the destination is not writable', () => {
  const dir = scratch()
  const { file, packageRoot } = reporter(dir)
  const blocker = path.join(dir, 'not-a-directory')
  writeFileSync(blocker, 'file')
  const out = path.join(blocker, 'logs', 'results.json')
  const result = run([file, packageRoot, 'control-api', 'isolated', out])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /could not be written/)
  assert.equal(existsSync(out), false)
})

test('projection fails on a reporter without test results', () => {
  const dir = scratch()
  const file = path.join(dir, 'empty.json')
  writeFileSync(file, JSON.stringify({ success: true, testResults: [] }))
  const out = path.join(dir, 'results.json')
  const result = run([file, dir, 'control-api', 'isolated', out])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /missing or empty/)
  assert.equal(existsSync(out), false)
})
