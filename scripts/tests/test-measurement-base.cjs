'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const script = path.join(root, 'scripts/dev/repo-intake-packet.sh')

test('measurement gate enforces ancestry before executing the benchmark', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const hostState = () => ['rev-parse HEAD', 'branch --show-current', 'status --porcelain=v1'].map((args) => git(root, ...args.split(' ')))
  const before = hostState()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-measurement-'))
  try {
    git(tmp, 'init', '-q')
    git(tmp, 'config', 'user.email', 'fixture@example.invalid')
    git(tmp, 'config', 'user.name', 'Fixture')
    git(tmp, 'commit', '--allow-empty', '-qm', 'base')
    git(tmp, 'branch', '-M', 'test/measurement')
    const base = git(tmp, 'rev-parse', 'HEAD')
    git(tmp, 'update-ref', 'refs/remotes/origin/dev', base)
    const run = (options = [], code = 'console.log("BENCHMARK_EXECUTED")') => spawnSync('bash', [script, '--measure', ...options, '--', process.execPath, '-e', code], {
      cwd: tmp, encoding: 'utf8', env: { ...process.env, REPO_INTAKE_BASE_REF: 'HEAD' },
    })
    const allowed = (options, label) => {
      const result = run(options)
      assert.equal(result.status, 0, result.stderr + result.stdout)
      assert.match(result.stdout, /BENCHMARK_EXECUTED/, label)
      return result
    }
    const blocked = (label) => {
      const result = run()
      assert.equal(result.status, 2, label + result.stderr + result.stdout)
      assert.doesNotMatch(result.stdout, /BENCHMARK_EXECUTED/, label)
    }
    allowed([], 'identical base')
    assert.equal(run([], 'process.exit(7)').status, 7, 'benchmark failure preserved')
    git(tmp, 'commit', '--allow-empty', '-qm', 'candidate')
    allowed([], 'ahead of base')
    const candidate = git(tmp, 'rev-parse', 'HEAD')
    git(tmp, 'update-ref', 'refs/remotes/origin/dev', candidate)
    git(tmp, 'checkout', '-q', '-B', 'test/historical', base)
    blocked('behind base, environment override ignored')
    const historical = allowed(['--historical-base', base], 'explicit historical comparison')
    assert.match(historical.stdout, /historical_non_certifying/)
    assert.match(historical.stdout, new RegExp(base))
    git(tmp, 'commit', '--allow-empty', '-qm', 'divergent')
    blocked('divergent base')
    git(tmp, 'update-ref', '-d', 'refs/remotes/origin/dev')
    blocked('missing base')
    git(tmp, 'update-ref', 'refs/remotes/origin/dev', base)
    git(tmp, 'checkout', '-q', '--detach', base)
    blocked('detached default')
    allowed(['--historical-base', base], 'detached historical')
    assert.equal(run(['--historical-base', 'missing-ref']).status, 2)
    assert.equal(run(['--historical-base']).status, 2)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    assert.deepEqual(hostState(), before, 'host checkout remains unchanged')
  }
})
