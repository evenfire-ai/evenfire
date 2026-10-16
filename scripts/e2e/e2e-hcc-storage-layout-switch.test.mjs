import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Runs single helpers of the #825 live gates (the switch script, the upgrade
// lane and their shared e2e-825-lib.sh) under bash with stubbed kubectl/curl,
// so their failure paths are checked without a cluster.

const SCRIPTS = [
  './e2e-hcc-storage-layout-switch.sh',
  './e2e-825-lib.sh',
  './e2e-hcc-layout-upgrade.sh',
].map(rel => fileURLToPath(new URL(rel, import.meta.url)))
const SOURCE = SCRIPTS.map(file => readFileSync(file, 'utf8')).join('\n')

function helper(name) {
  const lines = SOURCE.split('\n')
  const start = lines.findIndex(l => l.startsWith(`${name}() {`))
  assert.notEqual(start, -1, `helper ${name} not found`)
  if (lines[start].trimEnd().endsWith('}')) return lines[start]
  const end = lines.findIndex((l, i) => i > start && l === '}')
  assert.notEqual(end, -1, `helper ${name} has no closing brace`)
  return lines.slice(start, end + 1).join('\n')
}

function bash(body, env = {}) {
  return spawnSync('bash', ['-c', body], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
    timeout: 30_000,
  })
}

const OPENED = '{"msg":"[ConversationStore] opened","dbPath":"/workspace/state.db"}'

function runStorePath(dir, readyAfterCalls) {
  const calls = path.join(dir, 'kctl-calls')
  writeFileSync(calls, '0')
  const body = `
fail() { echo "FAIL — $*"; }
kctl() {
  local n; n=$(cat "$CALLS"); echo $((n + 1)) >"$CALLS"
  echo 'not json'
  if [ "$READY_AFTER" -ge 0 ] && [ "$n" -ge "$READY_AFTER" ]; then echo '${OPENED}'; fi
}
POD_JSON='{"metadata":{"name":"pod-1"}}' HOST_NS=e2e STORE_LOG_TIMEOUT=3
${helper('store_path')}
db="$(store_path s1)"; rc=$?
printf 'RC=%s DB=[%s]\\n' "$rc" "$db"
`
  const run = bash(body, { CALLS: calls, READY_AFTER: String(readyAfterCalls) })
  return { ...run, calls: Number(readFileSync(calls, 'utf8').trim()) }
}

test('store_path re-reads the log until the store-opened line appears', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-825-store-path-'))
  try {
    const run = runStorePath(dir, 1)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), 'RC=0 DB=[/workspace/state.db]')
    assert.equal(run.calls, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store_path reports its failure reason on stderr, not in the captured value', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-825-store-path-'))
  try {
    const run = runStorePath(dir, -1)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), 'RC=1 DB=[]')
    assert.match(run.stderr, /s1: expected one store-opened line in pod-1/)
    // Witness: the log was read more than once before giving up.
    assert.ok(run.calls > 1, `kctl calls: ${run.calls}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('admin and rpc send their credentials through a header file, never in curl argv', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-825-headers-'))
  try {
    const argv = path.join(dir, 'argv')
    const sent = path.join(dir, 'sent-headers')
    const body = `
curl() {
  printf '%s\\n' "$@" >>"$ARGV"
  local a; for a in "$@"; do case $a in @*) cat "\${a#@}" >>"$SENT" ;; esac; done
  cat >/dev/null; printf 'ok\\n200'
}
SCRATCH="$DIR" ADMIN_COOKIE=cookie-secret-1 RPC_TOKEN=rpc-secret-2 HTTP_HEADERS=()
${helper('auth_header')}
${helper('http')}
${helper('admin')}
${helper('rpc')}
admin GET http://127.0.0.1:1/admin && rpc GET http://127.0.0.1:2/rpc && echo "CODE=$HTTP_CODE"
`
    const run = bash(body, { DIR: dir, ARGV: argv, SENT: sent })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), 'CODE=200')
    const args = readFileSync(argv, 'utf8')
    assert.doesNotMatch(args, /secret/)
    // Witness: both credentials did reach curl, through the files.
    assert.equal(
      readFileSync(sent, 'utf8'),
      'Cookie: control_ui_admin_session=cookie-secret-1\nAuthorization: Bearer rpc-secret-2\n'
    )
    for (const kind of ['admin', 'rpc']) {
      assert.equal(statSync(path.join(dir, `${kind}.header`)).mode & 0o777, 0o600)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('admin_login and user_login keep passwords out of jq argv', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-825-login-'))
  try {
    const realJq = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim()
    assert.ok(realJq, 'jq not found on PATH')
    const bin = path.join(dir, 'bin')
    const jqArgv = path.join(dir, 'jq-argv')
    const sent = path.join(dir, 'sent-bodies')
    spawnSync('mkdir', [bin])
    // A PATH executable, not a shell function: what ps would show is the argv
    // of this process.
    writeFileSync(
      path.join(bin, 'jq'),
      `#!/bin/sh\nprintf '%s\\n' "$@" >>"$JQ_ARGV"\nexec '${realJq}' "$@"\n`,
      { mode: 0o755 }
    )
    const body = `
fail() { echo "FAIL — $*"; }
curl() {
  local prev= a
  for a in "$@"; do
    [ "$prev" = -D ] && printf 'Set-Cookie: control_ui_admin_session=c1; Path=/\\r\\n' >"$a"
    prev=$a
  done
  cat >>"$SENT"; echo >>"$SENT"
  printf '{"token":"t1"}\\n200'
}
SCRATCH="$DIR" CAPI=http://127.0.0.1:1 EXT_BASE=http://127.0.0.1:2 HTTP_HEADERS=()
ADMIN_USERNAME=admin ADMIN_PASSWORD='admin pw-secret-1' DEV_EMAIL=dev@example.test DEV_PASSWORD='dev"pw-secret-2'
${helper('http')}
${helper('admin_login')}
${helper('user_login')}
admin_login && user_login && echo "OK $ADMIN_COOKIE $SESSION_TOKEN"
`
    const run = bash(body, {
      DIR: dir,
      SENT: sent,
      JQ_ARGV: jqArgv,
      PATH: `${bin}:${process.env.PATH}`,
    })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), 'OK c1 t1')
    const args = readFileSync(jqArgv, 'utf8')
    assert.doesNotMatch(args, /pw-secret/)
    // Witness: jq built both login bodies, and they carry the exact passwords.
    assert.match(args, /username/)
    assert.match(args, /email/)
    assert.deepEqual(
      readFileSync(sent, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
      [
        { username: 'admin', password: 'admin pw-secret-1' },
        { email: 'dev@example.test', password: 'dev"pw-secret-2' },
      ]
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main_evidence_ok accepts only a passing main log of the same HEAD', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-825-upgrade-evidence-'))
  try {
    const head = 'a'.repeat(40)
    const write = (name, lines) => {
      const file = path.join(dir, name)
      writeFileSync(file, `${lines.join('\n')}\n`)
      return file
    }
    const cases = [
      ['pass', write('pass', ['PASS: x', 'E2E_UPGRADE_HEAD=' + head, 'E2E_UPGRADE_MAIN=PASS']), 0],
      ['fail', write('fail', ['E2E_UPGRADE_HEAD=' + head, 'E2E_UPGRADE_MAIN=FAIL']), 1],
      [
        'other head',
        write('other', ['E2E_UPGRADE_HEAD=' + 'b'.repeat(40), 'E2E_UPGRADE_MAIN=PASS']),
        1,
      ],
      [
        'head prefix only',
        write('prefix', ['E2E_UPGRADE_HEAD=' + head.slice(0, 9), 'E2E_UPGRADE_MAIN=PASS']),
        1,
      ],
      ['missing file', path.join(dir, 'absent'), 1],
    ]
    const body = `
${helper('main_evidence_ok')}
for f in "$@"; do main_evidence_ok "$f" "$HEAD" && echo 0 || echo 1; done
`
    const run = spawnSync('bash', ['-c', body, 'bash', ...cases.map(c => c[1])], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HEAD: head },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(
      run.stdout.trim().split('\n').map(Number),
      cases.map(c => c[2]),
      cases.map(c => c[0]).join(', ')
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function runUpgrade(args, env) {
  return spawnSync('bash', [SCRIPTS[2], ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 30_000,
  })
}

test('the upgrade lane refuses an unknown mode before touching the cluster', () => {
  const run = runUpgrade(['bogus'], { KUBECONTEXT: 'clerum-test-upgrade-lane-0123abcd' })
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout + run.stderr, /usage: e2e-hcc-layout-upgrade\.sh main\|control/)
  // Witness: a valid mode passes the mode check and stops at a later precondition.
  const valid = runUpgrade(['main'], { KUBECONTEXT: 'minikube' })
  assert.equal(valid.status, 1, valid.stdout + valid.stderr)
  assert.doesNotMatch(valid.stdout + valid.stderr, /usage:/)
})

test('the upgrade lane refuses a context that is not a branch profile', () => {
  const run = runUpgrade(['main'], { KUBECONTEXT: 'minikube' })
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout + run.stderr, /select an explicit branch-scoped Minikube context/)
})

test('no curl call in the #825 scripts puts a Cookie or Authorization header in argv', () => {
  assert.doesNotMatch(SOURCE, /-H\s+["']?(Cookie|Authorization):/i)
  // Witness: the credentials are still sent, through auth_header.
  const uses = SOURCE.match(/auth_header (admin|session|rpc) /g) ?? []
  assert.ok(uses.length >= 4, `auth_header uses: ${uses.length}`)
})
