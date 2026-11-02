import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = join(sourceRoot, 'scripts/ci/certification-inputs.mjs')
const sha256 = text => createHash('sha256').update(text).digest('hex')
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function initGit(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'Synthetic Fixture')
  git(dir, 'config', 'user.email', 'fixture@example.test')
}

function producerFixture(dir, label) {
  initGit(dir)
  write(join(dir, '.gitignore'), 'node_modules/\ndist/\n')
  write(join(dir, 'control-api/src/db.ts'), `// ${label} db\n`)
  write(join(dir, 'control-api/src/migrate.ts'), `// ${label} migration\n`)
  for (const pkg of ['control-api', 'packages/workflow-runtime-core']) {
    write(join(dir, pkg, 'package.json'), JSON.stringify({ name: pkg.replaceAll('/', '-'), version: '1.0.0' }))
    write(join(dir, pkg, 'package-lock.json'), '{}\n')
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'fixture source')
  return {
    commit: git(dir, 'rev-parse', 'HEAD'),
    sourceHashes: {
      'control-api/src/db.ts': sha256(readFileSync(join(dir, 'control-api/src/db.ts'))),
      'control-api/src/migrate.ts': sha256(readFileSync(join(dir, 'control-api/src/migrate.ts'))),
    },
    buildPackages: ['packages/workflow-runtime-core', 'control-api'],
    artifactDirectories: ['packages/workflow-runtime-core/dist', 'control-api/dist'],
    lockfiles: ['packages/workflow-runtime-core/package-lock.json', 'control-api/package-lock.json'],
    runner: 'control-api/dist/migrate.js',
  }
}

function fixture(t) {
  const scratch = process.env.CODEX_SCRATCH_ROOT
  assert.ok(scratch, 'CODEX_SCRATCH_ROOT is required')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'certification-inputs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'project')
  const observed = join(dir, 'observed')
  const latest = join(dir, 'latest')
  const bin = join(dir, 'bin')
  const audit = join(dir, 'audit.log')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  write(npm, [
    '#!/bin/sh',
    'printf "%s %s\n" "$PWD" "$1" >> "$FIXTURE_AUDIT"',
    'if [ "$1" = ls ]; then [ ! -e .missing-dependency ] || exit 9; printf "{}\n"; exit 0; fi',
    'if [ "$1" = run ] && [ "$2" = build ]; then',
    '  mkdir -p dist',
    '  case "$PWD" in */control-api) printf built > dist/migrate.js ;; */workflow-runtime-core) printf built > dist/index.js ;; esac',
    '  exit 0',
    'fi',
    'exit 90',
  ].join('\n') + '\n')
  chmodSync(npm, 0o755)
  for (const binary of ['docker', 'kubectl']) {
    const path = join(bin, binary)
    write(path, '#!/bin/sh\nprintf mutation >> "$FIXTURE_MUTATION"\nexit 99\n')
    chmodSync(path, 0o755)
  }
  const producerObserved = producerFixture(observed, 'observed')
  const producerLatest = producerFixture(latest, 'latest')
  initGit(root)
  write(join(root, '.gitignore'), 'node_modules/\ndist/\n')
  for (const pkg of ['mcp-host', 'codex-llm-proxy', 'grok-llm-proxy', 'control-api', 'gfs-controller', 'external-rest-api', 'packages/workflow-runtime-core']) {
    write(join(root, pkg, 'package.json'), JSON.stringify({ name: pkg.replaceAll('/', '-'), version: '1.0.0' }))
    write(join(root, pkg, 'package-lock.json'), '{}\n')
  }
  write(join(root, 'mcp-host/node_modules/better-sqlite3/index.js'), 'module.exports = class { close() {} }\n')
  write(join(root, 'mcp-host/node_modules/@napi-rs/canvas/index.js'), 'module.exports = {}\n')
  write(join(root, 'external-rest-api/dist/app.js'), '// synthetic build\n')
  write(join(root, 'packages/workflow-runtime-core/dist/index.js'), '// synthetic build\n')
  write(join(root, 'scripts/minikube/pre-gate-sync.sh'), 'run_if_changed mcp-host "npm test"\n')
  const suites = {
    version: 1,
    publicPostgres: ['control-api/test/public.realPostgres.test.ts'],
    privatePostgres: { local: 'control-api/test/local.realPostgres.test.ts', configured: 'control-api/test/configured.realPostgres.test.ts' },
    composedContract: ['control-api/test/contract.test.ts'],
    consumer: ['external-rest-api/test/consumer.test.ts'],
  }
  for (const file of [...suites.publicPostgres, ...Object.values(suites.privatePostgres), ...suites.composedContract, ...suites.consumer]) write(join(root, file), '// synthetic suite\n')
  write(join(root, 'tests/contracts/password-recovery-suites.json'), JSON.stringify(suites))
  const contract = {
    version: 1,
    suiteManifest: 'tests/contracts/password-recovery-suites.json',
    preGateScript: 'scripts/minikube/pre-gate-sync.sh',
    t1Packages: ['control-api', 'external-rest-api', 'packages/workflow-runtime-core'],
    t1TestRoots: ['control-api'],
    localT1ExtraPackages: ['gfs-controller'],
    consumerDependencies: { 'mcp-host': ['codex-llm-proxy', 'grok-llm-proxy'] },
    consumerArtifacts: { 'control-api': ['external-rest-api/dist/app.js'] },
    nativeChecks: { 'mcp-host': [{ package: 'mcp-host', kind: 'sqlite' }, { package: 'mcp-host', kind: 'canvas' }] },
    producers: {
      observedDev: { env: 'TASK106_R61_B1_DEV_SOURCE_DIR', ...producerObserved },
      latestDev: { env: 'TASK106_R61_B1_LATEST_DEV_SOURCE_DIR', ...producerLatest },
    },
  }
  write(join(root, 'tests/contracts/certification-inputs.json'), JSON.stringify(contract))
  write(join(root, 'mcp-host/src/example.ts'), '// baseline\n')
  write(join(root, 'tests/e2e/fixtures/package.json'), JSON.stringify({ name: 'synthetic-e2e', version: '1.0.0' }))
  write(join(root, 'tests/e2e/fixtures/example.ts'), '// baseline\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'fixture baseline')
  const base = git(root, 'rev-parse', 'HEAD')
  write(join(root, 'mcp-host/src/example.ts'), '// changed\n')
  write(join(root, 'tests/e2e/fixtures/example.ts'), '// changed\n')
  git(root, 'add', 'mcp-host/src/example.ts', 'tests/e2e/fixtures/example.ts')
  git(root, 'commit', '-qm', 'fixture change')
  const head = git(root, 'rev-parse', 'HEAD')
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, FIXTURE_AUDIT: audit, FIXTURE_MUTATION: join(dir, 'mutation'), TASK106_R61_B1_DEV_SOURCE_DIR: observed, TASK106_R61_B1_LATEST_DEV_SOURCE_DIR: latest }
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8', env, timeout: 30000 })
  return { root, observed, latest, audit, env, base, head, invoke, mutation: join(dir, 'mutation') }
}

function ready(f) {
  for (const name of ['observedDev', 'latestDev']) {
    const result = f.invoke('build-producer', '--producer', name)
    assert.equal(result.status, 0, result.stderr)
  }
}

function check(f, ...args) {
  return f.invoke('check', '--scope', 't2', '--base', f.base, '--head', f.head, ...args)
}

test('complete inputs pass and preflight never calls a cluster mutation', t => {
  const f = fixture(t); ready(f)
  const result = check(f)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CERTIFICATION_INPUTS=PASS/)
  assert.equal(existsSync(f.mutation), false)
  assert.equal(git(f.root, 'status', '--porcelain'), '')
})

test('missing cross-service dependency is reported before any cluster mutation', t => {
  const f = fixture(t); ready(f)
  write(join(f.root, 'grok-llm-proxy/.missing-dependency'), '')
  const result = check(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /grok-llm-proxy/)
  assert.equal(existsSync(f.mutation), false)
})

test('missing producer directory is reported before any cluster mutation', t => {
  const f = fixture(t); ready(f)
  delete f.env.TASK106_R61_B1_LATEST_DEV_SOURCE_DIR
  const result = check(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /TASK106_R61_B1_LATEST_DEV_SOURCE_DIR/)
  assert.equal(existsSync(f.mutation), false)
})

test('dirty producer and changed build artifacts invalidate provenance', t => {
  const f = fixture(t); ready(f)
  write(join(f.observed, 'control-api/src/db.ts'), '// changed after pin\n')
  let result = check(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /observedDev/)
  git(f.observed, 'checkout', '--', 'control-api/src/db.ts')
  write(join(f.latest, 'control-api/dist/migrate.js'), '// changed after build\n')
  result = check(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /latestDev/)
  assert.equal(existsSync(f.mutation), false)
})

test('an unregistered real PostgreSQL suite fails before any cluster mutation', t => {
  const f = fixture(t); ready(f)
  write(join(f.root, 'control-api/test/new.realPostgres.test.ts'), '// newly discovered suite\n')
  const result = check(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /census|manifest/i)
  assert.equal(existsSync(f.mutation), false)
})

test('matrix scope checks cross-service dependencies without requiring T1 producers', t => {
  const f = fixture(t)
  delete f.env.TASK106_R61_B1_DEV_SOURCE_DIR
  delete f.env.TASK106_R61_B1_LATEST_DEV_SOURCE_DIR
  let result = f.invoke('check', '--scope', 'matrix', '--service', 'mcp-host')
  assert.equal(result.status, 0, result.stderr)
  write(join(f.root, 'codex-llm-proxy/.missing-dependency'), '')
  result = f.invoke('check', '--scope', 'matrix', '--service', 'mcp-host')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /codex-llm-proxy/)
  assert.equal(existsSync(f.mutation), false)
})

test('an unloadable native dependency fails without attempting a rebuild', t => {
  const f = fixture(t); ready(f)
  write(join(f.root, 'mcp-host/node_modules/better-sqlite3/index.js'), 'throw new Error("synthetic ABI failure")\n')
  const result = check(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /mcp-host.*sqlite/i)
  assert.equal(existsSync(f.mutation), false)
  assert.doesNotMatch(readFileSync(f.audit, 'utf8'), /rebuild|install/)
})

test('T0 and preflight share affected-package discovery without executing tests', t => {
  const f = fixture(t)
  const listed = f.invoke('list-affected', '--base', f.base, '--head', f.head)
  assert.equal(listed.status, 0, listed.stderr)
  const actual = spawnSync('/bin/bash', [join(sourceRoot, 'scripts/minikube/t0.sh'), '--list-packages'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...f.env, T0_PROJECT_DIR: f.root, T0_ORIGIN_DEV: f.base, T0_HEAD: f.head },
  })
  assert.equal(actual.status, 0, actual.stderr)
  assert.deepEqual(actual.stdout.trim().split('\n'), listed.stdout.trim().split('\n'))
  assert.deepEqual(actual.stdout.trim().split('\n').sort(), ['mcp-host', 'tests/e2e/fixtures'])
  assert.equal(existsSync(f.audit), false, 'listing packages must not run npm')
  assert.equal(existsSync(f.mutation), false)
})

test('T0-only preflight does not require producers reserved for T1', t => {
  const f = fixture(t)
  delete f.env.TASK106_R61_B1_DEV_SOURCE_DIR
  delete f.env.TASK106_R61_B1_LATEST_DEV_SOURCE_DIR
  const result = f.invoke('check', '--scope', 't0', '--base', f.base, '--head', f.head)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(f.mutation), false)
})

test('orchestrator rejects missing T1 inputs before T0 or bootstrap', t => {
  const f = fixture(t); ready(f)
  delete f.env.TASK106_R61_B1_LATEST_DEV_SOURCE_DIR
  const t0Marker = join(dirname(f.root), 't0-started')
  const bootstrapMarker = join(dirname(f.root), 'bootstrap-started')
  const shell = [
    'source "$FIXTURE_T2_SOURCE"',
    't2_require_commands() { :; }',
    't2_repo_metadata() { T2_PROJECT_DIR="$FIXTURE_ROOT"; T2_ORIGIN_DEV="$FIXTURE_BASE"; T2_HEAD="$FIXTURE_HEAD"; }',
    't2_profile_scope() { :; }',
    't2_profile_status() { T2_BOOTSTRAP_REQUIRED=true; }',
    't2_context_check() { :; }',
    't2_mutation_lock() { :; }',
    't2_prior_targeted_health_pending() { printf false; }',
    't2_evidence_init() { :; }',
    't2_evidence_write() { :; }',
    't2_lock_release() { :; }',
    'real_pg_local_preflight() { return 0; }',
    't2_fail() { printf "%s\n" "$*" >&2; return 1; }',
    'run_t0() { printf started > "$FIXTURE_T0"; return 97; }',
    'run_bootstrap_or_reconcile() { printf started > "$FIXTURE_BOOTSTRAP"; return 98; }',
    'main',
  ].join('\n')
  const shellEnv = { ...f.env, T2_RUN_T0: 'true', T2_RUN_T1: 'true', FIXTURE_T2_SOURCE: join(sourceRoot, 'scripts/minikube/t2.sh'), FIXTURE_ROOT: f.root, FIXTURE_BASE: f.base, FIXTURE_HEAD: f.head, FIXTURE_T0: t0Marker, FIXTURE_BOOTSTRAP: bootstrapMarker }
  delete shellEnv.BASH_ENV
  delete shellEnv.ENV
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', shell], {
    encoding: 'utf8', timeout: 30000, env: shellEnv,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /TASK106_R61_B1_LATEST_DEV_SOURCE_DIR/)
  assert.equal(existsSync(t0Marker), false, 'T0 must not start with missing producer inputs')
  assert.equal(existsSync(bootstrapMarker), false, 'bootstrap must not start with missing producer inputs')
  assert.equal(existsSync(f.mutation), false)
})

test('a source-only dependency does not impose the sibling test suite artifacts', t => {
  const f = fixture(t)
  const contractPath = join(f.root, 'tests/contracts/certification-inputs.json')
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  contract.consumerDependencies['external-rest-api'] = ['control-api']
  contract.consumerArtifacts['control-api'] = ['packages/workflow-runtime-core/dist/index.js']
  write(contractPath, JSON.stringify(contract))
  rmSync(join(f.root, 'packages/workflow-runtime-core/dist/index.js'))
  const result = f.invoke('check', '--scope', 'matrix', '--service', 'external-rest-api')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(f.mutation), false)
})

test('an unrecognized pre-gate declaration fails closed', t => {
  const f = fixture(t); ready(f)
  write(join(f.root, 'scripts/minikube/pre-gate-sync.sh'), 'run_if_changed "$dynamic" "npm test"\n')
  const result = check(f)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /pre-gate package declaration/i)
  assert.equal(existsSync(f.mutation), false)
})

test('empty affected-package selection is valid and does not start npm', t => {
  const f = fixture(t)
  const actual = spawnSync('/bin/bash', [join(sourceRoot, 'scripts/minikube/t0.sh'), '--list-packages'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...f.env, T0_PROJECT_DIR: f.root, T0_ORIGIN_DEV: f.head, T0_HEAD: f.head },
  })
  assert.equal(actual.status, 0, actual.stderr)
  assert.equal(actual.stdout.trim(), '')
  assert.equal(existsSync(f.audit), false)
})

test('Git range arguments cannot be interpreted as command options', t => {
  const f = fixture(t)
  const result = f.invoke('list-affected', '--base', '--help', '--head', f.head)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /invalid Git range/)
  assert.equal(existsSync(f.audit), false)
  assert.equal(existsSync(f.mutation), false)
})
