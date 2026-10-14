import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

// Exercise shell selection with fake node/npm only; never execute a private producer suite.
for (const mode of ['local', 'configured']) {
  for (const selector of ['failure', 'empty', 'directory', 'multiple', 'valid']) {
    test(`${mode} selector ${selector} enforces exact execution`, () => {
      const scratchRoot = process.env.CODEX_SCRATCH_ROOT
      assert.ok(scratchRoot, 'CODEX_SCRATCH_ROOT is required for hermetic runner fixtures')
      const repositoryScratch = join(scratchRoot, 'evenfire')
      mkdirSync(repositoryScratch, { recursive: true })
      const fixture = mkdtempSync(join(repositoryScratch, 'recovery-selector-'))
      try {
        for (const directory of [
          'scripts/ci',
          'control-api/test',
          'external-rest-api/dist',
          'bin',
          'node_modules/.bin',
        ])
          mkdirSync(join(fixture, directory), { recursive: true })
        copyFileSync(
          join(root, 'scripts/ci/run-pr1056-private-recovery-postgres.sh'),
          join(fixture, 'scripts/ci/runner.sh')
        )
        writeFileSync(
          join(fixture, 'external-rest-api/dist/app.js'),
          '// synthetic build prerequisite\n'
        )
        writeFileSync(join(fixture, 'control-api/test/fake.test.ts'), '// fixture only\n')
        mkdirSync(join(fixture, 'node_modules/.bin'), { recursive: true })
        writeFileSync(join(fixture, 'node_modules/.bin/tsx'), '#!/bin/sh\nexit 91\n', {
          mode: 0o755,
        })
        const output =
          selector === 'failure'
            ? 'exit 1'
            : selector === 'empty'
              ? 'exit 0'
              : selector === 'directory'
                ? "printf 'test/\\n'"
                : selector === 'valid'
                  ? "printf 'test/fake.test.ts\\n'"
                  : "printf 'test/fake.test.ts\\ntest/fake.test.ts\\n'"
        writeFileSync(join(fixture, 'bin/node'), '#!/bin/sh\n' + output + '\n', { mode: 0o755 })
        const marker = join(fixture, 'test-launched')
        writeFileSync(
          join(fixture, 'bin/npm'),
          '#!/bin/sh\nprintf launched > "$TASK_SELECTION_MARKER"\nprintf "Test Files 1 passed\\nTests 1 passed\\n"\n',
          { mode: 0o755 }
        )
        const result = spawnSync('/bin/bash', [join(fixture, 'scripts/ci/runner.sh'), mode], {
          timeout: 5000,
          encoding: 'utf8',
          env: {
            PATH: join(fixture, 'bin') + ':' + process.env.PATH,
            TASK_SELECTION_MARKER: marker,
            CONTROL_API_REAL_PG_ADMIN_URL: 'synthetic-not-a-database',
            CONTROL_API_REAL_MEMBER_REGISTRATION_PG_URL: 'synthetic-not-a-database',
            CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL: 'synthetic-not-a-service',
            CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET: 'synthetic-fixture-only',
            EVENFIRE_MEMBER_REGISTRATION_ROOT: fixture,
          },
        })
        if (selector === 'valid') {
          assert.equal(result.status, 0, 'valid exact fixture selection must run')
          assert.equal(readFileSync(marker, 'utf8'), 'launched')
        } else {
          assert.notEqual(result.status, 0, 'invalid selector must fail before any test invocation')
          assert.throws(() => readFileSync(marker), 'npm must never launch for invalid selection')
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    })
  }
}
