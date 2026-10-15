import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Runs single helpers of e2e-hcc-storage-layout-switch.sh under bash with
// stubbed kubectl/curl, so their failure paths are checked without a cluster.

const SCRIPT = fileURLToPath(new URL('./e2e-hcc-storage-layout-switch.sh', import.meta.url))
const SOURCE = readFileSync(SCRIPT, 'utf8')

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

test('no curl call in the script puts a Cookie or Authorization header in argv', () => {
  assert.doesNotMatch(SOURCE, /-H\s+["']?(Cookie|Authorization):/i)
  // Witness: the credentials are still sent, through auth_header.
  const uses = SOURCE.match(/auth_header (admin|session|rpc) /g) ?? []
  assert.ok(uses.length >= 4, `auth_header uses: ${uses.length}`)
})
