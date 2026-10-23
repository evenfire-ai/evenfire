import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
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
test('pathname replacement cannot substitute nonempty contents after a suite is opened', () => {
  const scratchRoot = process.env.CODEX_SCRATCH_ROOT
  assert.ok(scratchRoot, 'CODEX_SCRATCH_ROOT is required for manifest fixtures')
  const repositoryScratch = join(scratchRoot, 'evenfire')
  mkdirSync(repositoryScratch, { recursive: true })
  const fixture = mkdtempSync(join(repositoryScratch, 'recovery-manifest-'))
  const selection = {
    version: 1,
    publicPostgres: ['control-api/test/public.realPostgres.test.ts'],
    privatePostgres: {
      local: 'control-api/test/local.realPostgres.test.ts',
      configured: 'control-api/test/configured.realPostgres.test.ts',
    },
    composedContract: ['control-api/test/contract.test.ts'],
    consumer: ['external-rest-api/test/consumer.test.ts'],
  }
  const originalRead = fs.readFileSync
  try {
    for (const directory of ['control-api/test', 'external-rest-api/test'])
      mkdirSync(join(fixture, directory), { recursive: true })
    for (const entry of [
      ...selection.publicPostgres,
      ...Object.values(selection.privatePostgres),
      ...selection.composedContract,
      ...selection.consumer,
    ])
      writeFileSync(join(fixture, entry), '// fixture\n')
    const selected = join(fixture, selection.publicPostgres[0])
    writeFileSync(selected, '')
    let replaced = false
    fs.readFileSync = (...args) => {
      if (!replaced) {
        replaced = true
        fs.renameSync(selected, join(fixture, 'original-empty-suite'))
        writeFileSync(selected, '// replacement\n')
      }
      return originalRead(...args)
    }
    syncBuiltinESMExports()
    assert.throws(() => verifySuiteManifest(fixture, selection), /Missing or empty recovery suite/)
    assert.equal(replaced, true)
  } finally {
    fs.readFileSync = originalRead
    syncBuiltinESMExports()
    rmSync(fixture, { recursive: true, force: true })
  }
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

function withMinikubeSelectionFixture(run) {
  const scratchRoot = process.env.CODEX_SCRATCH_ROOT
  assert.ok(scratchRoot, 'CODEX_SCRATCH_ROOT is required for selection fixtures')
  mkdirSync(scratchRoot, { recursive: true })
  const fixture = mkdtempSync(join(scratchRoot, 'minikube-pg-selection-'))
  try {
    for (const directory of ['scripts/ci', 'tests/contracts', 'gfs-controller/test'])
      mkdirSync(join(fixture, directory), { recursive: true })
    for (const file of [
      'scripts/ci/password-recovery-suite-contract.mjs',
      'scripts/ci/assert-pinned-vitest-suites.mjs',
      'tests/contracts/password-recovery-suites.json',
    ])
      copyFileSync(join(root, file), join(fixture, file))
    // Only inventory discovery runs here; these synthetic files are never executed.
    for (const file of [
      ...manifest.publicPostgres,
      ...Object.values(manifest.privatePostgres),
      ...manifest.composedContract,
      ...manifest.consumer,
      'gfs-controller/test/public.realPostgres.test.ts',
    ]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true })
      writeFileSync(join(fixture, file), '// synthetic suite inventory entry\n')
    }
    run(fixture)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function minikubeSelection(fixture, packageName = 'control-api', runSuite = false) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `source "$TASK_T1_SOURCE"
trap - EXIT INT TERM
PROJECT_DIR="$TASK_SELECTION_ROOT"
if [ "$TASK_RUN_SUITE" = true ]; then
  t2_evidence_write() { :; }
  npm() { printf launched > "$TASK_SELECTION_ROOT/npm-launched"; return 97; }
  T1_TMP_DIR="$TASK_SELECTION_ROOT"
  run_suite control-api isolated synthetic-inventory-only
else
  list_real_pg_files "$TASK_SELECTION_PACKAGE"
fi`,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        TASK_T1_SOURCE: join(root, 'scripts/e2e/minikube-real-postgres.sh'),
        TASK_SELECTION_ROOT: fixture,
        TASK_SELECTION_PACKAGE: packageName,
        TASK_RUN_SUITE: String(runSuite),
      },
    }
  )
}

test('Minikube T1 selects the exact public inventory and preserves GFS discovery', () => {
  withMinikubeSelectionFixture(fixture => {
    const control = minikubeSelection(fixture)
    assert.equal(control.status, 0, control.stderr)
    assert.deepEqual(
      control.stdout.trim().split('\n').sort(),
      manifest.publicPostgres.map(file => join(fixture, file)).sort()
    )
    const gfs = minikubeSelection(fixture, 'gfs-controller')
    assert.equal(gfs.status, 0, gfs.stderr)
    assert.equal(gfs.stdout.trim(), join(fixture, 'gfs-controller/test/public.realPostgres.test.ts'))
  })
})

test('suite CLI validates the census through a symlinked entry point', () => {
  withMinikubeSelectionFixture(fixture => {
    const alias = join(fixture, 'suite-cli.mjs')
    symlinkSync(join(fixture, 'scripts/ci/password-recovery-suite-contract.mjs'), alias)
    const selected = spawnSync(process.execPath, [alias, 'public'], { encoding: 'utf8' })
    assert.equal(selected.status, 0, selected.stderr)
    assert.deepEqual(selected.stdout.trim().split('\n'), manifest.publicPostgres)

    rmSync(join(fixture, manifest.privatePostgres.local))
    const rejected = spawnSync(process.execPath, [alias, 'verify'], { encoding: 'utf8' })
    assert.notEqual(rejected.status, 0, 'a symlinked CLI must still validate every declared suite')
    assert.match(rejected.stderr, /ENOENT|Missing or empty recovery suite/)
  })
})

for (const fault of ['missing-private-suite', 'unregistered-suite']) {
  test(`Minikube T1 rejects ${fault} before launching npm`, () => {
    withMinikubeSelectionFixture(fixture => {
      if (fault === 'missing-private-suite') rmSync(join(fixture, manifest.privatePostgres.local))
      else writeFileSync(join(fixture, 'control-api/test/unregistered.realPostgres.test.ts'), '// fixture\n')
      const selection = minikubeSelection(fixture)
      assert.notEqual(selection.status, 0, 'invalid census must fail selection')
      const execution = minikubeSelection(fixture, 'control-api', true)
      assert.notEqual(execution.status, 0)
      assert.match(execution.stderr, /REAL_PG_REPORT_INCOMPLETE/)
      assert.equal(fs.existsSync(join(fixture, 'npm-launched')), false)
    })
  })
}

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
          join(root, 'scripts/ci/run-password-recovery-private-postgres.sh'),
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
