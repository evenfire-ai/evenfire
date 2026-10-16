import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Runs host-layout-merge.sh against a fake kubectl that answers from canned
// JSON and records every call, so the inventory, the turn-off gate and the
// check Pods are exercised without a cluster. All names are synthetic.

const SCRIPT = fileURLToPath(new URL('./host-layout-merge.sh', import.meta.url))
const CONTEXT = 'test-context'
const NS = 'mcp-host'

const FAKE_KUBECTL = `#!/usr/bin/env node
const fs = require('fs')
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_KUBECTL_FIXTURE, 'utf8'))
const args = process.argv.slice(2)
const stdin = args.includes('-f') ? fs.readFileSync(0, 'utf8') : ''
fs.appendFileSync(process.env.FAKE_KUBECTL_LOG, JSON.stringify({ args, stdin }) + '\\n')
const out = (s, code = 0) => { process.stdout.write(s); process.exit(code) }
if (!args.includes('--context=' + fx.context)) { process.stderr.write('missing --context'); process.exit(97) }
const rest = args.filter(a => !a.startsWith('--context=')).join(' ')
const statePath = process.env.FAKE_KUBECTL_LOG + '.pods.json'
const pods = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
const save = () => fs.writeFileSync(statePath, JSON.stringify(pods))
if (rest === 'create -f -') {
  const m = JSON.parse(stdin)
  const claim = m.spec.volumes[0].persistentVolumeClaim.claimName
  pods[m.metadata.name] = claim
  save()
  out('pod/' + m.metadata.name + ' created\\n')
}
let m = rest.match(/^get pod (\\S+) -n \\S+ -o json$/)
if (m && pods[m[1]]) {
  const check = fx.checks[pods[m[1]]] || {}
  out(JSON.stringify({ status: { phase: check.phase || 'Succeeded', containerStatuses: check.containerStatuses || [] } }))
}
m = rest.match(/^logs (\\S+) -n \\S+$/)
if (m && pods[m[1]]) out(fx.checks[pods[m[1]]].output)
m = rest.match(/^delete pod (\\S+) -n \\S+ --wait=true --timeout=60s$/)
if (m && pods[m[1]]) {
  if ((fx.checks[pods[m[1]]] || {}).deleteFails) { process.stderr.write('delete refused'); process.exit(1) }
  delete pods[m[1]]
  save()
  out('pod "' + m[1] + '" deleted\\n')
}
const r = fx.responses[rest]
if (!r) { process.stderr.write('fake kubectl: unexpected call: ' + rest); process.exit(98) }
if (r.stderr) process.stderr.write(r.stderr)
out(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout), r.status || 0)
`

function hcc(env = []) {
  return {
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [
            {
              name: 'host-context-controller',
              env: [
                { name: 'CONTEXT_MAPPER_HOST_IMAGE', value: 'registry.test/mcp-host:head' },
                ...env,
              ],
            },
          ],
        },
      },
    },
    status: { readyReplicas: 1, updatedReplicas: 1 },
  }
}

function hostCr(name, spec = {}) {
  return { metadata: { name, namespace: NS }, spec: { contextRef: 'ctx', ...spec } }
}

function hostDeployment(name, { replicas = 1, inits = ['workspace-layout-merge'], subPath, containers } = {}) {
  const mount = { name: 'workspace', mountPath: '/workspace', ...(subPath ? { subPath } : {}) }
  return {
    metadata: { name, labels: { app: name, 'clerum.io/host': name } },
    spec: {
      replicas,
      template: {
        spec: {
          initContainers: inits.map(n => ({ name: n, volumeMounts: [{ name: 'workspace', mountPath: '/mnt/workspace-root' }] })),
          containers: containers ?? [
            { name: 'mcp-host', image: `registry.test/mcp-host:${name}`, imagePullPolicy: 'IfNotPresent', volumeMounts: [mount] },
          ],
          imagePullSecrets: [{ name: 'pull-secret' }],
          volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: `${name}-workspace` } }],
        },
      },
    },
  }
}

function hostPod(host, node, mergeStatus) {
  return {
    metadata: { name: `${host}-pod`, labels: { app: host, 'clerum.io/host': host } },
    spec: { nodeName: node },
    status: {
      phase: 'Running',
      initContainerStatuses: mergeStatus === undefined ? [] : [{ name: 'workspace-layout-merge', ...mergeStatus }],
    },
  }
}

function pvc(host) {
  return {
    metadata: {
      name: `${host}-workspace`,
      labels: { 'clerum.io/managed-by': 'host-context-controller', 'clerum.io/host': host },
    },
  }
}

const EXITED_0 = { state: { terminated: { exitCode: 0 } } }
const F2_LINE = 'workspace layout merge refused: more than one live SQLite database across /mnt/workspace-root, /mnt/workspace-root/state and /mnt/workspace-root/workspace'

// A stateful active Host, a suspended stateless Host and a desktop Host whose
// mcp-host container is not the first one, plus a channel-reader Deployment
// and Pod that carry a Host label and must be ignored.
function fleet() {
  return {
    hcc: hcc(),
    hosts: [
      hostCr('alpha'),
      hostCr('beta', { lifecycle: { stateless: true } }),
      hostCr('gamma', { desktop: { browser: true } }),
    ],
    deployments: [
      hostDeployment('alpha'),
      hostDeployment('beta', { replicas: 0 }),
      hostDeployment('gamma', {
        containers: [
          { name: 'x11', image: 'registry.test/x11:1' },
          { name: 'mcp-host', image: 'registry.test/mcp-host-desktop:gamma', imagePullPolicy: 'Always', volumeMounts: [{ name: 'workspace', mountPath: '/config/workspace' }] },
        ],
      }),
      { metadata: { name: 'channel-reader-alpha', labels: { app: 'channel-reader', 'clerum.io/host': 'alpha' } }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'reader' }] } } } },
    ],
    pods: [
      hostPod('alpha', 'node-a', EXITED_0),
      hostPod('gamma', 'node-b', EXITED_0),
      { metadata: { name: 'channel-reader-alpha-pod', labels: { app: 'channel-reader', 'clerum.io/host': 'alpha' } }, spec: { nodeName: 'node-c' }, status: { phase: 'Running' } },
    ],
    pvcs: [pvc('alpha'), pvc('beta'), pvc('gamma')],
    checks: {
      'alpha-workspace': { output: 'NO_SPLIT_SIGNATURE\n' },
      'beta-workspace': { output: 'NO_SPLIT_SIGNATURE\n' },
      'gamma-workspace': { output: 'NO_SPLIT_SIGNATURE\n' },
    },
    extra: {},
  }
}

function responses(f) {
  const list = items => ({ stdout: { items } })
  return {
    'get deployment host-context-controller -n control-plane -o json': { stdout: f.hcc },
    [`get hosts.clerum.io -n ${NS} -o json`]: list(f.hosts),
    [`get deployments -n ${NS} -l clerum.io/host -o json`]: list(f.deployments),
    [`get pods -n ${NS} -l clerum.io/host -o json`]: list(f.pods),
    [`get pvc -n ${NS} -l clerum.io/managed-by=host-context-controller -o json`]: list(f.pvcs),
    ...f.extra,
  }
}

function run(f, args) {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-layout-merge-test-'))
  try {
    const kubectl = path.join(dir, 'kubectl')
    writeFileSync(kubectl, FAKE_KUBECTL, { mode: 0o755 })
    const fixture = path.join(dir, 'fixture.json')
    writeFileSync(fixture, JSON.stringify({ context: CONTEXT, responses: responses(f), checks: f.checks }))
    const log = path.join(dir, 'calls.jsonl')
    writeFileSync(log, '')
    const res = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, KUBECTL_BIN: kubectl, FAKE_KUBECTL_FIXTURE: fixture, FAKE_KUBECTL_LOG: log },
    })
    if (res.error) throw res.error
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const verify = (f, ...extra) => run(f, ['verify', '--context', CONTEXT, ...extra])
const inventory = (f, ...extra) => run(f, ['inventory', '--context', CONTEXT, ...extra])

function row(out, pvcName) {
  const lines = out.split('\n').filter(l => l.startsWith(`PVC ${NS}/${pvcName} `))
  assert.equal(lines.length, 1, `one row for ${pvcName} in:\n${out}`)
  return lines[0]
}

const verbs = calls => calls.map(c => c.args.filter(a => !a.startsWith('--context='))[0])
const creates = calls => calls.filter(c => verbs([c])[0] === 'create').map(c => JSON.parse(c.stdin))

function assertReadOnlyCalls(calls) {
  assert.ok(calls.length > 0, 'kubectl was called')
  for (const c of calls) assert.ok(c.args.includes(`--context=${CONTEXT}`), `call without --context: ${c.args.join(' ')}`)
  for (const verb of verbs(calls)) assert.ok(['get', 'logs'].includes(verb), `mutating call: ${verb}`)
}

function assertCheckPodsOnly(calls, claims) {
  for (const c of calls) assert.ok(c.args.includes(`--context=${CONTEXT}`), `call without --context: ${c.args.join(' ')}`)
  const mutating = verbs(calls).filter(v => !['get', 'logs'].includes(v))
  assert.deepEqual(mutating.sort(), [...claims.map(() => 'create'), ...claims.map(() => 'delete')].sort())
  assert.deepEqual(creates(calls).map(m => m.spec.volumes[0].persistentVolumeClaim.claimName).sort(), [...claims].sort())
}

test('verify passes a merged fleet and checks only the PVC without a Pod', () => {
  const r = verify(fleet())
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^HOST_LAYOUT_VERIFY=PASS$/m)
  assert.match(row(r.stdout, 'alpha-workspace'), /host=alpha kind=STATEFUL state=ACTIVE result=POD_OK$/)
  assert.match(row(r.stdout, 'beta-workspace'), /host=beta kind=STATELESS state=SUSPENDED result=NO_SPLIT_SIGNATURE$/)
  assert.match(row(r.stdout, 'gamma-workspace'), /host=gamma kind=DESKTOP state=ACTIVE result=POD_OK$/)
  assert.match(r.stdout, /^COUNTS total=3 pod_ok=2 no_split=1 split=0 refused=0 running=0 unreadable=0 unverified=0 unknown=0 template_stale=0$/m)
  assert.match(r.stdout, /^PVC_CONTENTS=NOT_INSPECTED$/m)
  assertCheckPodsOnly(r.calls, ['beta-workspace'])

  const [pod] = creates(r.calls)
  assert.equal(pod.spec.nodeName, undefined)
  assert.equal(pod.spec.automountServiceAccountToken, false)
  assert.equal(pod.spec.securityContext.fsGroup, undefined)
  assert.equal(pod.spec.securityContext.runAsUser, 1001)
  assert.equal(pod.spec.securityContext.runAsGroup, 1001)
  assert.equal(pod.spec.volumes[0].persistentVolumeClaim.readOnly, true)
  assert.deepEqual(pod.spec.containers[0].volumeMounts, [{ name: 'pvc', mountPath: '/mnt/workspace-root', readOnly: true }])
  assert.equal(pod.spec.containers[0].image, 'registry.test/mcp-host:beta')
  assert.equal(pod.spec.containers[0].imagePullPolicy, 'IfNotPresent')
  assert.deepEqual(pod.spec.imagePullSecrets, [{ name: 'pull-secret' }])
  assert.deepEqual(pod.spec.containers[0].securityContext.capabilities, { drop: ['ALL'] })
  assert.doesNotMatch(pod.spec.containers[0].command[2], /\bmv |\brmdir /)
})

test('inventory reads every PVC, pinning running Hosts to their node', () => {
  const f = fleet()
  f.checks['beta-workspace'].output = 'WILL_MERGE\n'
  const r = inventory(f)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^HOST_LAYOUT_INVENTORY=OK$/m)
  assert.match(r.stdout, /^UPGRADE_BLOCKERS=0$/m)
  assert.match(row(r.stdout, 'beta-workspace'), /result=WILL_MERGE$/)
  assert.match(r.stdout, /^DESKTOP_HOSTS=1 /m)
  assert.match(r.stdout, /^PRE_825=no$/m)
  assertCheckPodsOnly(r.calls, ['alpha-workspace', 'beta-workspace', 'gamma-workspace'])
  const nodes = Object.fromEntries(creates(r.calls).map(m => [m.spec.volumes[0].persistentVolumeClaim.claimName, m.spec.nodeName]))
  assert.deepEqual(nodes, { 'alpha-workspace': 'node-a', 'beta-workspace': undefined, 'gamma-workspace': 'node-b' })
})

test('inventory reports a Host switched to stateful before the upgrade as a blocker (T5)', () => {
  const f = fleet()
  f.checks['alpha-workspace'].output = `WILL_REFUSE_F2 ${F2_LINE}\n`
  const r = inventory(f)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /^UPGRADE_BLOCKERS=1$/m)
  assert.match(r.stdout, /^HOST_LAYOUT_INVENTORY=BLOCKED$/m)
  assert.ok(row(r.stdout, 'alpha-workspace').endsWith(`result=WILL_REFUSE_F2 ${F2_LINE}`))
})

test('inventory reports a legacy fleet as PRE_825 and still reads it', () => {
  const f = fleet()
  f.deployments[1] = hostDeployment('beta', { replicas: 0, inits: ['workspace-layout-init'], subPath: 'workspace' })
  f.checks['beta-workspace'].output = 'WILL_MERGE\n'
  const r = inventory(f)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^PRE_825=yes$/m)
  assert.match(r.stdout, /^HOST beta kind=STATELESS state=SUSPENDED template=LEGACY_INIT subPath=yes$/m)
  assert.match(row(r.stdout, 'beta-workspace'), /result=WILL_MERGE$/)
})

test('--no-pvc-pods starts no Pod: inventory reports UNVERIFIED, verify fails', () => {
  const inv = inventory(fleet(), '--no-pvc-pods')
  assert.equal(inv.status, 0, inv.stdout + inv.stderr)
  assert.match(row(inv.stdout, 'beta-workspace'), /result=UNVERIFIED$/)
  assertReadOnlyCalls(inv.calls)

  const ver = verify(fleet(), '--no-pvc-pods')
  assert.equal(ver.status, 1, ver.stdout + ver.stderr)
  assert.match(row(ver.stdout, 'alpha-workspace'), /result=POD_OK$/)
  assert.match(row(ver.stdout, 'beta-workspace'), /result=UNVERIFIED$/)
  assert.match(ver.stdout, /^HOST_LAYOUT_VERIFY=FAIL$/m)
  assertReadOnlyCalls(ver.calls)
})

test('the merge flag decides the verdict before any PVC is read', () => {
  for (const [env, verdict] of [
    [{ name: 'CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE', value: 'ture' }, 'FLAG_INVALID'],
    [{ name: 'CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE', valueFrom: { configMapKeyRef: { name: 'c', key: 'k' } } }, 'FLAG_UNRESOLVED'],
  ]) {
    const f = fleet()
    f.hcc = hcc([env])
    const r = verify(f)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`^HOST_LAYOUT_VERIFY=${verdict}$`, 'm'))
    assertReadOnlyCalls(r.calls)
  }
  const on = fleet()
  on.hcc = hcc([{ name: 'CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE', value: 'true' }])
  assert.equal(verify(on).status, 0)
})

test('flag false: ALREADY_OFF without split trees, FLAG_FALSE_WITH_SPLIT_TREES with one', () => {
  const off = fleet()
  off.hcc = hcc([{ name: 'CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE', value: 'false' }])
  const clean = verify(off)
  assert.equal(clean.status, 1, clean.stdout + clean.stderr)
  assert.match(clean.stdout, /^HOST_LAYOUT_VERIFY=ALREADY_OFF$/m)
  // With the flag off a running Pod has no merge init to read, so every PVC is read.
  assertCheckPodsOnly(clean.calls, ['alpha-workspace', 'beta-workspace', 'gamma-workspace'])

  off.checks['beta-workspace'].output = 'WILL_MERGE\n'
  for (const r of [verify(off), inventory(off)]) {
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^FLAG_FALSE_WITH_SPLIT_TREES=1$/m)
  }
  assert.match(verify(off).stdout, /^HOST_LAYOUT_VERIFY=FLAG_FALSE_WITH_SPLIT_TREES$/m)
})

test('verify stops at PRE_825 for a legacy init or a workspace subPath', () => {
  for (const dep of [
    hostDeployment('alpha', { inits: ['workspace-layout-init'] }),
    hostDeployment('alpha', { subPath: 'workspace' }),
  ]) {
    const f = fleet()
    f.deployments[0] = dep
    const r = verify(f)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /^HOST_LAYOUT_VERIFY=PRE_825$/m)
    assertReadOnlyCalls(r.calls)
  }
})

test('verify fails a Host Deployment that does not render the merge init', () => {
  const f = fleet()
  f.deployments[0] = hostDeployment('alpha', { inits: [] })
  const r = verify(f)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /^HOST alpha kind=STATEFUL state=ACTIVE template=NO_INIT subPath=no$/m)
  assert.match(r.stdout, / template_stale=1$/m)
  assert.match(r.stdout, /^HOST_LAYOUT_VERIFY=FAIL$/m)
})

test('verify reads the merge init status of running Pods', () => {
  const cases = [
    [{ state: { running: {} } }, 'MERGE_RUNNING', null],
    [{ state: { terminated: { exitCode: 1 } } }, `MERGE_REFUSED ${F2_LINE}`, ''],
    [{ state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 1 } } }, `MERGE_REFUSED ${F2_LINE}`, ' --previous'],
    [{ state: { terminated: { exitCode: 137 } } }, 'UNKNOWN', null],
    [undefined, 'UNKNOWN', null],
  ]
  for (const [status, result, logsFlag] of cases) {
    const f = fleet()
    f.pods[0] = hostPod('alpha', 'node-a', status)
    if (logsFlag !== null) {
      f.extra[`logs alpha-pod -n ${NS} -c workspace-layout-merge${logsFlag}`] = { stdout: `${F2_LINE}\n` }
    }
    const r = verify(f)
    assert.equal(r.status, 1, `${result}: ${r.stdout}${r.stderr}`)
    assert.ok(row(r.stdout, 'alpha-workspace').endsWith(`result=${result}`), row(r.stdout, 'alpha-workspace'))
    assert.match(r.stdout, /^HOST_LAYOUT_VERIFY=FAIL$/m)
  }
  const recovered = fleet()
  recovered.pods[0] = hostPod('alpha', 'node-a', { state: { terminated: { exitCode: 0 } }, lastState: { terminated: { exitCode: 1 } } })
  const r = verify(recovered)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(row(r.stdout, 'alpha-workspace'), /result=POD_OK$/)
})

test('verify fails a suspended Host whose PVC is still split or unreadable', () => {
  const cases = [
    [{ output: 'WILL_MERGE\n' }, 'SPLIT', / split=1 /],
    [{ output: `WILL_REFUSE_F2 ${F2_LINE}\n` }, `WILL_REFUSE_F2 ${F2_LINE}`, / refused=1 /],
    [{ output: '' }, 'UNREADABLE', / unreadable=1 /],
    [{ output: 'WILL_MERGE\nNO_SPLIT_SIGNATURE\n' }, 'UNREADABLE', / unreadable=1 /],
    [{ phase: 'Failed', output: 'sh: boom\n' }, 'UNREADABLE', / unreadable=1 /],
    [{ phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] }, 'UNREADABLE', / unreadable=1 /],
  ]
  for (const [check, result, count] of cases) {
    const f = fleet()
    f.checks['beta-workspace'] = check
    const r = verify(f, '--check-timeout', '0')
    assert.equal(r.status, 1, `${result}: ${r.stdout}${r.stderr}`)
    assert.ok(row(r.stdout, 'beta-workspace').includes(`result=${result}`), row(r.stdout, 'beta-workspace'))
    assert.match(r.stdout, count)
    assert.match(r.stdout, /^HOST_LAYOUT_VERIFY=FAIL$/m)
    // The check Pod is deleted whatever it printed.
    assertCheckPodsOnly(r.calls, ['beta-workspace'])
  }
})

test('an orphan split PVC is reported without blocking the verdict (T9)', () => {
  const f = fleet()
  f.pvcs.push(pvc('delta'))
  f.checks['delta-workspace'] = { output: 'WILL_MERGE\n' }
  const r = verify(f)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(row(r.stdout, 'delta-workspace'), /host=delta kind=ORPHAN state=NO_HOST result=SPLIT$/)
  assert.match(r.stdout, /^ORPHANS=1 ORPHAN_SPLIT=1$/m)
  assert.match(r.stdout, /^HOST_LAYOUT_VERIFY=PASS$/m)
  const orphanPod = creates(r.calls).find(m => m.spec.volumes[0].persistentVolumeClaim.claimName === 'delta-workspace')
  assert.equal(orphanPod.spec.containers[0].image, 'registry.test/mcp-host:head')
  assert.equal(orphanPod.spec.containers[0].imagePullPolicy, 'Always')
  assert.deepEqual(orphanPod.spec.imagePullSecrets, [{ name: 'clerum' }])
})

test('read failures, an empty scope and a failed cleanup exit 2', () => {
  const empty = fleet()
  empty.hosts = []
  empty.deployments = []
  empty.pods = []
  empty.pvcs = []
  const e = verify(empty)
  assert.equal(e.status, 2, e.stdout + e.stderr)
  assert.match(e.stderr, /no Host and no Host PVC/)

  const failing = fleet()
  failing.extra[`get pods -n ${NS} -l clerum.io/host -o json`] = { stdout: { items: [] }, status: 1, stderr: 'forbidden' }
  const f = verify(failing)
  assert.equal(f.status, 2, f.stdout + f.stderr)
  assert.match(f.stderr, /forbidden/)
  assert.doesNotMatch(f.stdout, /HOST_LAYOUT_VERIFY=/)

  const notReady = fleet()
  notReady.hcc.status.readyReplicas = 0
  const n = verify(notReady)
  assert.equal(n.status, 2, n.stdout + n.stderr)
  assert.match(n.stderr, /HCC_NOT_READY/)

  const stuck = fleet()
  stuck.checks['beta-workspace'].deleteFails = true
  const s = verify(stuck)
  assert.equal(s.status, 2, s.stdout + s.stderr)
  assert.match(s.stderr, /delete/)
})

test('usage errors exit 2 without calling kubectl', () => {
  for (const args of [['verify'], ['inventory', '--context'], ['verify', '--context', CONTEXT, '--bogus'], ['frobnicate', '--context', CONTEXT], []]) {
    const r = run(fleet(), args)
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
    assert.equal(r.calls.length, 0)
  }
})

// The check the Pods run, on real trees. Each tree's listing is asserted
// before its token so a wrong fixture cannot pass as a wrong token.
function tree(build) {
  const root = mkdtempSync(path.join(tmpdir(), 'host-layout-check-tree-'))
  build(root)
  return root
}

function check(root) {
  const printed = spawnSync('bash', [SCRIPT, 'check-script', '--root', root], { encoding: 'utf8' })
  assert.equal(printed.status, 0, printed.stderr)
  const res = spawnSync('/bin/sh', ['-c', printed.stdout], { encoding: 'utf8' })
  assert.equal(res.stderr, '')
  assert.equal(res.status, 0)
  return res.stdout
}

const file = (p, body = 'x') => writeFileSync(p, body)

test('check-script classifies split, foreign and refused trees', () => {
  const trees = [
    ['split', r => { mkdirSync(`${r}/state`); mkdirSync(`${r}/workspace`); file(`${r}/state/state.db`); file(`${r}/workspace/SOUL.md`) }, ['state', 'workspace'], 'WILL_MERGE\n'],
    ['backup only', r => { mkdirSync(`${r}/state`); mkdirSync(`${r}/workspace`); file(`${r}/state/state.db.pre-1.bak`) }, ['state', 'workspace'], 'WILL_MERGE\n'],
    ['foreign state.db name', r => { mkdirSync(`${r}/state`); mkdirSync(`${r}/workspace`); file(`${r}/state/state.db.json`) }, ['state', 'workspace'], 'NO_SPLIT_SIGNATURE\n'],
    ['symlinked state', r => { mkdirSync(`${r}/elsewhere`); file(`${r}/elsewhere/state.db`); symlinkSync('elsewhere', `${r}/state`); mkdirSync(`${r}/workspace`) }, ['elsewhere', 'state', 'workspace'], 'NO_SPLIT_SIGNATURE\n'],
    ['workspace missing', r => { mkdirSync(`${r}/state`); file(`${r}/state/state.db`) }, ['state'], 'NO_SPLIT_SIGNATURE\n'],
    ['stateful root', r => { file(`${r}/state.db`); file(`${r}/SOUL.md`) }, ['SOUL.md', 'state.db'], 'NO_SPLIT_SIGNATURE\n'],
    ['T5', r => { file(`${r}/state.db`); mkdirSync(`${r}/state`); mkdirSync(`${r}/workspace`); file(`${r}/state/state.db`) }, ['state', 'state.db', 'workspace'], `WILL_REFUSE_F2 workspace layout merge refused: more than one live SQLite database across ROOT, ROOT/state and ROOT/workspace\n`],
    ['read-only directory to move', r => { mkdirSync(`${r}/state`); mkdirSync(`${r}/workspace`); file(`${r}/state/state.db`); mkdirSync(`${r}/workspace/users`); chmodSync(`${r}/workspace/users`, 0o555) }, ['state', 'workspace'], 'WILL_REFUSE_F4 workspace layout merge refused: not writable by uid UID: ROOT/workspace/users\n'],
  ]
  const uid = String(process.getuid())
  for (const [name, build, listing, expected] of trees) {
    const root = tree(build)
    try {
      assert.deepEqual(listDir(root), listing, name)
      assert.equal(check(root), expected.replaceAll('ROOT', root).replaceAll('UID', uid), name)
      assert.deepEqual(listDir(root), listing, `${name}: the check changed the tree`)
    } finally {
      chmodTree(root)
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('check-script refuses an unlistable state/ like the merge init does', { skip: process.getuid() === 0 && 'root reads any mode' }, () => {
  const root = tree(r => { mkdirSync(`${r}/state`); mkdirSync(`${r}/workspace`); file(`${r}/state/state.db`); chmodSync(`${r}/state`, 0o300) })
  try {
    assert.equal(check(root), `WILL_REFUSE_F1 workspace layout merge refused: state directory is not readable and searchable: ${root}/state\n`)
  } finally {
    chmodTree(root)
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-script ends before the moves', () => {
  const printed = spawnSync('bash', [SCRIPT, 'check-script'], { encoding: 'utf8' })
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(printed.stdout, /^root='\/mnt\/workspace-root'$/m)
  assert.match(printed.stdout, /\necho WILL_MERGE\n$/)
  assert.doesNotMatch(printed.stdout, /\bmv |\brmdir |\[ -w /)
})

function listDir(root) {
  return spawnSync('ls', ['-A', root], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort()
}

function chmodTree(root) {
  spawnSync('chmod', ['-R', 'u+rwx', root])
}
