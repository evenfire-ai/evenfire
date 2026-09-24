'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const script = path.join(root, 'scripts/dev/repo-intake-packet.sh')
// An inherited GIT_DIR or GIT_INDEX_FILE (a git hook, for example) would point
// the fixture commands at the host repository.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))

test('measurement gate enforces ancestry before executing the benchmark', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()
  const hostState = () => ['rev-parse HEAD', 'branch --show-current', 'status --porcelain=v1'].map((args) => git(root, ...args.split(' ')))
  const before = hostState()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-measurement-'))
  let failure
  try {
    git(tmp, 'init', '-q')
    git(tmp, 'config', 'user.email', 'fixture@example.invalid')
    git(tmp, 'config', 'user.name', 'Fixture')
    git(tmp, 'commit', '--allow-empty', '-qm', 'base')
    git(tmp, 'branch', '-M', 'test/measurement')
    const base = git(tmp, 'rev-parse', 'HEAD')
    git(tmp, 'update-ref', 'refs/remotes/origin/dev', base)
    const spawn = (args) => spawnSync('bash', [script, ...args], {
      cwd: tmp, encoding: 'utf8', env: { ...env, REPO_INTAKE_BASE_REF: 'HEAD' },
    })
    const run = (options = [], code = 'console.log("BENCHMARK_EXECUTED")') =>
      spawn(['--measure', ...options, '--', process.execPath, '-e', code])
    const allowed = (options, label) => {
      const result = run(options)
      assert.equal(result.status, 0, result.stderr + result.stdout)
      assert.match(result.stdout, /BENCHMARK_EXECUTED/, label)
      return result
    }
    // Each blocked case names its blocker, so a gate that blocks for the wrong
    // reason fails here.
    const blocked = (blocker, label) => {
      const result = run()
      assert.equal(result.status, 2, label + result.stderr + result.stdout)
      assert.match(result.stdout, /measurement_readiness:\s+blocked/, label)
      assert.match(result.stdout, new RegExp(`blockers:\\s+.*${blocker}`), label + result.stdout)
      assert.doesNotMatch(result.stdout, /BENCHMARK_EXECUTED/, label)
    }
    const normal = allowed([], 'identical base')
    assert.match(normal.stdout, /measurement_readiness:\s+base_check_passed_not_a_lane_verdict/)
    assert.equal(run([], 'process.exit(7)').status, 7, 'benchmark failure preserved')
    git(tmp, 'commit', '--allow-empty', '-qm', 'candidate')
    allowed([], 'ahead of base')
    const candidate = git(tmp, 'rev-parse', 'HEAD')
    git(tmp, 'update-ref', 'refs/remotes/origin/dev', candidate)
    git(tmp, 'checkout', '-q', '-B', 'test/historical', base)
    blocked('branch_missing_origin/dev_commits', 'behind base, environment override ignored')
    const historical = allowed(['--historical-base', base], 'explicit historical comparison')
    assert.match(historical.stdout, /historical_non_certifying/)
    assert.match(historical.stdout, new RegExp(base))
    git(tmp, 'commit', '--allow-empty', '-qm', 'divergent')
    blocked('branch_missing_origin/dev_commits', 'divergent base')
    git(tmp, 'update-ref', '-d', 'refs/remotes/origin/dev')
    blocked('missing_origin/dev', 'missing base')
    git(tmp, 'update-ref', 'refs/remotes/origin/dev', base)
    git(tmp, 'checkout', '-q', '--detach', base)
    blocked('detached_measurement', 'detached default')
    allowed(['--historical-base', base], 'detached historical')
    assert.equal(run(['--historical-base', 'missing-ref']).status, 2)
    assert.equal(run(['--historical-base']).status, 2)

    const unknown = spawn(['--unexpected'])
    assert.equal(unknown.status, 2, unknown.stderr + unknown.stdout)
    assert.match(unknown.stderr, /unknown repo intake arguments/)

    git(tmp, 'checkout', '-q', '-B', 'test/conflict', base)
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'base\n')
    git(tmp, 'add', 'f.txt')
    git(tmp, 'commit', '-qm', 'file')
    git(tmp, 'update-ref', 'refs/remotes/origin/dev', git(tmp, 'rev-parse', 'HEAD'))
    git(tmp, 'checkout', '-q', '-b', 'test/other')
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'other\n')
    git(tmp, 'commit', '-qam', 'other')
    git(tmp, 'checkout', '-q', 'test/conflict')
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'mine\n')
    git(tmp, 'commit', '-qam', 'mine')
    const merge = spawnSync('git', ['merge', '-q', 'test/other'], { cwd: tmp, encoding: 'utf8', env })
    assert.notEqual(merge.status, 0, 'fixture merge must conflict')
    assert.match(git(tmp, 'status', '--porcelain=v1'), /^UU f\.txt$/m)
    blocked('unresolved_conflicts', 'conflicted index')
    git(tmp, 'merge', '--abort')

    fs.writeFileSync(path.join(tmp, '.git', 'index'), 'not an index')
    assert.notEqual(spawnSync('git', ['status'], { cwd: tmp, env }).status, 0, 'fixture index must be unreadable')
    blocked('status_unreadable', 'unreadable status')
  } catch (error) {
    failure = error
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  // Checked after the body so a host-state difference never replaces the
  // body's own error.
  if (failure) throw failure
  assert.deepEqual(hostState(), before, 'host checkout remains unchanged')
})
