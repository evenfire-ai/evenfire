import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Runs single helpers of e2e-stateless-suspend-wake.sh under bash with a
// stubbed curl, so credential handling is checked without a cluster.

const SCRIPT = fileURLToPath(new URL('./e2e-stateless-suspend-wake.sh', import.meta.url))
const SOURCE = readFileSync(SCRIPT, 'utf8')

function helper(name) {
  const lines = SOURCE.split('\n')
  const start = lines.findIndex(l => l.startsWith(`${name}() {`))
  assert.notEqual(start, -1, `helper ${name} not found`)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  assert.notEqual(end, -1, `helper ${name} has no closing brace`)
  return lines.slice(start, end + 1).join('\n')
}

test('read_thread_messages sends the RPC bearer through a 0600 header file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-suspend-wake-auth-'))
  try {
    const argv = path.join(dir, 'argv')
    const sent = path.join(dir, 'sent')
    const files = path.join(dir, 'files')
    writeFileSync(argv, '')
    writeFileSync(sent, '')
    writeFileSync(files, '')
    const body = `
SCRATCH="$DIR"
RPC_BASE=http://127.0.0.1:1 HOST_REF=h1 THREAD_ID=t1
mint_rpc_token() { RPC_TOKEN=rpc-secret-1; }
curl() {
  printf '%s\\n' "$@" >>"$ARGV"
  local a
  for a in "$@"; do
    case "$a" in @*) cat "\${a#@}" >>"$SENT"; printf '%s\\n' "\${a#@}" >>"$FILES" ;; esac
  done
  printf '[{"role":"user"}]\\n200'
}
${helper('auth_header')}
${helper('read_thread_messages')}
read_thread_messages && printf 'MESSAGES=%s\\n' "$THREAD_MESSAGES"
`
    const run = spawnSync('bash', ['-c', body], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, DIR: dir, ARGV: argv, SENT: sent, FILES: files },
      timeout: 30_000,
    })
    assert.equal(run.status, 0, run.stderr)
    // Liveness witness: the helper parsed the stubbed response.
    assert.equal(run.stdout.trim(), 'MESSAGES=[{"role":"user"}]')
    assert.doesNotMatch(readFileSync(argv, 'utf8'), /secret/)
    // Witness: the credential still reached curl, through the file.
    assert.equal(readFileSync(sent, 'utf8'), 'Authorization: Bearer rpc-secret-1\n')
    const headerFiles = readFileSync(files, 'utf8').trim().split('\n')
    assert.equal(headerFiles.length, 1)
    assert.equal(statSync(headerFiles[0]).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no curl call in the script puts a Cookie or Authorization header in argv', () => {
  assert.doesNotMatch(SOURCE, /-H\s+["']?(Cookie|Authorization):/i)
  assert.doesNotMatch(SOURCE, /-H\s+["']?\$\(rpc_auth_header\)/)
  // Witness: the credentials are still sent, through auth_header.
  const uses = SOURCE.match(/-H "@\$\(auth_header "Authorization: Bearer /g) ?? []
  assert.ok(uses.length >= 10, `auth_header uses: ${uses.length}`)
})
