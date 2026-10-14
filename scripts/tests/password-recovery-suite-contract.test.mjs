import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { reportViolations, verifySuiteManifest } from '../ci/password-recovery-suite-contract.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const manifest = JSON.parse(
  readFileSync(new URL('../../tests/contracts/password-recovery-suites.json', import.meta.url))
)
const green = () => ({
  success: true,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numTotalTests: manifest.publicPostgres.length,
  numPassedTests: manifest.publicPostgres.length,
  testResults: manifest.publicPostgres.map(name => ({
    name: `${root}/${name}`,
    status: 'passed',
    assertionResults: [{ status: 'passed' }],
  })),
})
test('exact checked-in census and full reporter pass', () => {
  assert.equal(verifySuiteManifest(root, manifest), manifest)
  assert.deepEqual(reportViolations(root, manifest, 'publicPostgres', green()), [])
})
for (const [label, mutate] of [
  [
    'unknown schema',
    m => {
      m.extra = []
    },
  ],
  [
    'missing private lane',
    m => {
      delete m.privatePostgres.local
    },
  ],
  [
    'unknown physical suite',
    m => {
      m.publicPostgres.push('control-api/test/missing.realPostgres.test.ts')
    },
  ],
  [
    'duplicate selection',
    m => {
      m.publicPostgres.push(m.publicPostgres[0])
    },
  ],
  [
    'empty required lane',
    m => {
      m.composedContract = []
    },
  ],
  [
    'removed public suite',
    m => {
      m.publicPostgres.pop()
    },
  ],
])
  test(label + ' fails closed', () => {
    const m = structuredClone(manifest)
    mutate(m)
    assert.throws(() => verifySuiteManifest(root, m))
  })
for (const [label, mutate] of [
  [
    'missing suite',
    r => {
      r.testResults.pop()
    },
  ],
  [
    'unexpected suite',
    r => {
      r.testResults.push({
        name: `${root}/control-api/test/unexpected.test.ts`,
        status: 'passed',
        assertionResults: [{ status: 'passed' }],
      })
    },
  ],
  [
    'zero collection',
    r => {
      r.testResults[0].assertionResults = []
    },
  ],
  [
    'skipped case',
    r => {
      r.testResults[0].assertionResults[0].status = 'pending'
    },
  ],
  [
    'partial report',
    r => {
      r.success = false
    },
  ],
  [
    'worker failure',
    r => {
      r.numFailedTestSuites = 1
    },
  ],
  [
    'incorrect totals',
    r => {
      r.numPassedTests--
    },
  ],
])
  test(label + ' rejects reporter', () => {
    const r = green()
    mutate(r)
    assert.notDeepEqual(reportViolations(root, manifest, 'publicPostgres', r), [])
  })
test('unknown report lane rejects', () =>
  assert.notDeepEqual(reportViolations(root, manifest, 'unknown', green()), []))
