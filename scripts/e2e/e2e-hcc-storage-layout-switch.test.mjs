import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
ADMIN_USERNAME=admin ADMIN_PASSWORD='admin fixture-pw-1' DEV_EMAIL=dev@example.test DEV_PASSWORD='dev"fixture-pw-2'
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
    assert.doesNotMatch(args, /fixture-pw/)
    // Witness: jq built both login bodies, and they carry the exact passwords.
    assert.match(args, /username/)
    assert.match(args, /email/)
    assert.deepEqual(
      readFileSync(sent, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
      [
        { username: 'admin', password: 'admin fixture-pw-1' },
        { email: 'dev@example.test', password: 'dev"fixture-pw-2' },
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

function runLayoutRow(dir, exits, rc) {
  const script = path.join(dir, 'host-layout-merge.sh')
  writeFileSync(script, `echo "PVC e2e/h1-workspace host=h1 result=WILL_MERGE"\nexit ${rc}\n`)
  const body = `
fail() { echo "FAIL — $*"; }
log() { :; }
SCRATCH="$DIR" LAYOUT_SCRIPT="$DIR/host-layout-merge.sh" E2E_KUBECONTEXT=ctx HOST_NS=e2e
${helper('layout_row')}
row="$(layout_row inventory h1 "$EXITS")"; rc=$?
printf 'RC=%s ROW=[%s]\\n' "$rc" "$row"
`
  return bash(body, { DIR: dir, EXITS: exits })
}

test('layout_row accepts every exit code in its list and refuses the others', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-825-layout-row-'))
  try {
    for (const [exits, rc, expected] of [
      ['0 1', 0, 'RC=0 ROW=[WILL_MERGE]'],
      ['0 1', 1, 'RC=0 ROW=[WILL_MERGE]'],
      ['1', 1, 'RC=0 ROW=[WILL_MERGE]'],
      ['1', 0, 'RC=1 ROW=[]'],
      ['0 1', 2, 'RC=1 ROW=[]'],
      ['0 1', 10, 'RC=1 ROW=[]'],
    ]) {
      const run = runLayoutRow(dir, exits, rc)
      assert.equal(run.status, 0, run.stderr)
      assert.equal(run.stdout.trim().split('\n').at(-1), expected, `exits=[${exits}] rc=${rc}: ${run.stdout}`)
      if (expected.startsWith('RC=1')) assert.match(run.stderr, new RegExp(`exited ${rc} \\(expected ${exits}\\)`))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('layout_row callers pass exit codes as a space-separated list', () => {
  const calls = SOURCE.match(/layout_row (inventory|verify) "\$name" \S+/g) ?? []
  // Witness: S5 and S6 call it five times.
  assert.equal(calls.length, 5, calls.join('\n'))
  for (const call of calls) assert.doesNotMatch(call, /\|/, call)
})

// A temp Git repo with one CRD and one deploy file at the tag, then HEAD.
function releaseRepo(headCrd, { extraHeadCrd = false, dropTagCrd = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-825-release-'))
  const git = (...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  const write = (rel, body) => {
    const file = path.join(dir, rel)
    spawnSync('mkdir', ['-p', path.dirname(file)])
    writeFileSync(file, body)
  }
  git('init', '-q')
  git('config', 'user.email', 'e2e@example.invalid')
  git('config', 'user.name', 'e2e fixture')
  write('charts/clerum-crds/crds/host.yaml', TAG_CRD)
  write('charts/clerum-crds/crds/llmhook.yaml', TAG_CRD)
  write('deploy/base/hcc.yaml', 'release: v0.11.0\n')
  write('deploy/overlays/minikube-ghcr/kustomization.yaml', 'resources: [../minikube]\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'release')
  git('tag', 'v0.11.0')
  write('charts/clerum-crds/crds/host.yaml', headCrd)
  if (extraHeadCrd) write('charts/clerum-crds/crds/extra.yaml', TAG_CRD)
  if (dropTagCrd) rmSync(path.join(dir, 'charts/clerum-crds/crds/llmhook.yaml'))
  write('deploy/base/hcc.yaml', 'release: head\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'head')
  return dir
}

const TAG_CRD = `spec:
  versions:
    - schema:
        openAPIV3Schema:
          description: Host is the agent runtime.
          properties:
            description:
              type: string
            replicas:
              description: Old wording.
              type: integer
`

function runCrdCheck(dir) {
  return bash(`fail() { echo "FAIL: $*" >&2; }
${helper('crd_schema')}
${helper('release_crds_match')}
release_crds_match ${JSON.stringify(dir)} v0.11.0`)
}

test('release_crds_match accepts CRDs that differ only in descriptions', () => {
  const dir = releaseRepo(TAG_CRD.replace('Host is the agent runtime.', 'New wording.').replace('Old wording.', 'Newer.'))
  try {
    const run = runCrdCheck(dir)
    assert.equal(run.status, 0, run.stdout + run.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release_crds_match refuses a schema change, naming the file', () => {
  for (const [label, crd] of [
    ['type change', TAG_CRD.replace('type: integer', 'type: string')],
    // A property named description is schema, not documentation.
    ['description property removed', TAG_CRD.replace('            description:\n              type: string\n', '')],
  ]) {
    const dir = releaseRepo(crd)
    try {
      const run = runCrdCheck(dir)
      assert.equal(run.status, 1, `${label}: ${run.stdout}${run.stderr}`)
      assert.match(run.stderr, /charts\/clerum-crds\/crds\/host\.yaml/, label)
      assert.doesNotMatch(run.stderr, /llmhook\.yaml/, label)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('release_crds_match refuses an added or removed CRD file', () => {
  for (const [label, opts, name] of [
    ['added', { extraHeadCrd: true }, /extra\.yaml/],
    ['removed', { dropTagCrd: true }, /llmhook\.yaml/],
  ]) {
    const dir = releaseRepo(TAG_CRD, opts)
    try {
      const run = runCrdCheck(dir)
      assert.equal(run.status, 1, `${label}: ${run.stdout}${run.stderr}`)
      assert.match(run.stderr, name, label)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('extract_release_deploy writes the tag deploy tree, not HEAD', () => {
  const dir = releaseRepo(TAG_CRD)
  const out = mkdtempSync(path.join(tmpdir(), 'e2e-825-release-tree-'))
  try {
    const run = bash(`fail() { echo "FAIL: $*" >&2; }
${helper('extract_release_deploy')}
extract_release_deploy ${JSON.stringify(dir)} v0.11.0 ${JSON.stringify(out)}`)
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.equal(readFileSync(path.join(out, 'deploy/base/hcc.yaml'), 'utf8'), 'release: v0.11.0\n')
    // Only deploy/ is extracted: the setup applies this tree's CRDs.
    assert.throws(() => statSync(path.join(out, 'charts')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('the upgrade lane installs the release deploy tree and checks the CRDs', () => {
  const install = helper('install_release')
  assert.match(install, /BRANCH_PROFILE_DEPLOY_DIR="\$RELEASE_TREE\/deploy"/)
  assert.match(install, /IMAGE_SOURCE=ghcr MINIKUBE_IMAGE_TAG="\$RELEASE"/)
  assert.match(install, /STDIO_BRIDGE_IMAGE/)
  assert.match(SOURCE, /release_crds_match "\$REPO_ROOT" "\$RELEASE" \|\|/)
  // The manifest-diff refusal is gone (A7.43).
  assert.doesNotMatch(SOURCE, /this tree no longer installs the release/)
})

// A7.46: the merge init supersedes the T5 split database, so the lane runs no
// repair step between the inventory and the upgrade.
test('the upgrade lane upgrades without a repair step', () => {
  const main = helper('run_main')
  // Witness: run_main is the lane's sequence and reaches the upgrade.
  assert.notEqual(main.indexOf('upgrade_to_head'), -1, 'run_main does not call upgrade_to_head')
  assert.doesNotMatch(SOURCE, /repair_blockers|REPAIR_STATE_FAMILY_SCRIPT/)
  assert.doesNotMatch(helper('check_upgraded'), /wait_refused_pod/)
})

// A7.45: the head setup's seed (seed-e2e-data.sh put_agents) resets the user's
// and team's agents, so the lane grants its rows' Hosts again before the mint.
test('login_all regrant grants every created Host before it mints', () => {
  assert.match(helper('upgrade_to_head'), /login_all regrant \|\| return 1/)
  const run = arg => bash(`
    set -u
    calls=()
    admin_login() { calls+=(admin_login); }
    admin() { HTTP_CODE=200; HTTP_BODY='{"items":[{"id":"t1","email":"u@x"}]}'; }
    user_login() { calls+=(user_login); }
    grant_host() { calls+=("grant:$1"); }
    mint_rpc_token() { calls+=(mint); }
    fail() { echo "FAIL $*"; }
    CAPI=http://capi DEV_EMAIL=u@x
    CREATED_HOSTS=(host-a host-b)
    ${helper('login_all')}
    login_all ${arg}; rc=$?
    printf '%s\\n' "\${calls[@]}"; echo "RC=$rc"
  `)
  const regrant = run('regrant')
  assert.equal(regrant.status, 0, regrant.stderr)
  assert.equal(regrant.stdout.trim(), 'admin_login\nuser_login\ngrant:host-a\ngrant:host-b\nmint\nRC=0')
  // Witness: the plain call reaches the mint and grants nothing.
  const plain = run('')
  assert.equal(plain.stdout.trim(), 'admin_login\nuser_login\nmint\nRC=0')
})

test('the lane T5 tree is classified as superseded, not refused', () => {
  const layoutScript = fileURLToPath(new URL('../../deploy/scripts/host-layout-merge.sh', import.meta.url))
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-825-t5-repair-'))
  try {
    for (const p of ['state', 'workspace']) mkdirSync(path.join(root, p))
    for (const p of ['state.db', 'state/state.db', 'state/state.db-wal', 'workspace/seed.txt']) writeFileSync(path.join(root, p), p)
    const classify = () => {
      const printed = spawnSync('bash', [layoutScript, 'check-script', '--root', root], { encoding: 'utf8' })
      assert.equal(printed.status, 0, printed.stderr)
      return spawnSync('/bin/sh', ['-c', printed.stdout], { encoding: 'utf8' }).stdout
    }
    // Witness: the tree carries the signature and both database families.
    assert.deepEqual(readdirSync(path.join(root, 'state')).sort(), ['state.db', 'state.db-wal'])
    assert.equal(classify(), 'WILL_SUPERSEDE\n')
    // The check is read-only: the tree is unchanged.
    assert.deepEqual(readdirSync(root).sort(), ['state', 'state.db', 'workspace'])
    assert.equal(readFileSync(path.join(root, 'state.db'), 'utf8'), 'state.db')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
