import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertDeployment,
  assertLane,
  assertNoResidue,
  command,
  deleteRequest,
  imageIdentity,
  journalWriter,
  makeFixtures,
  runOwnedProbe,
  runtimeReport,
  verifyPolicyCleanup,
  verifyWorkloadCleanup,
} from './playwright-mcp-cluster-probe.mjs'

const image =
  'ghcr.io/evenfire-ai/playwright-server@sha256:fc603bbc05d216ca9394940463e5e216d0a48732c24555fb9b67d20775fccf73'
const runId = 'pw-mcp-0123456789ab'
const manifest = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'McpServer',
  metadata: { name: 'playwright-server', namespace: 'mcp-server' },
  spec: {
    image,
    command: ['node'],
    args: ['cli.js', '--headless'],
    transport: { type: 'streamableHttp', url: 'http://fixture', port: 8931 },
  },
}
const resources = makeFixtures(manifest, runId)

test('runs lane preflight when invoked through a symlink', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'playwright-cluster-entry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const entry = fileURLToPath(new URL('./playwright-mcp-cluster-probe.mjs', import.meta.url))
  const linkedEntry = path.join(directory, 'probe.mjs')
  symlinkSync(entry, linkedEntry)

  for (const target of [entry, linkedEntry]) {
    const result = spawnSync(process.execPath, [target], {
      env: { PATH: '' },
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(result.status, 1, `${target}: ${result.stderr}`)
    assert.match(
      result.stderr,
      /PLAYWRIGHT_MCP_CLUSTER_FAIL stage=preflight code=LANE_IDENTITY_INVALID/
    )
  }
})

// One CommonJS file stands in for bash, git and kubectl on an isolated PATH, so
// the CLI runs end to end without reaching a cluster. Unknown calls exit 97.
const fakeTool = `
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
const dir = process.env.PROBE_FAKE_DIR
const scenario = process.env.PROBE_FAKE_SCENARIO
const statePath = path.join(dir, 'server.json')
const record = body =>
  appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ tool, args, body }) + '\\n')
let output = ''
let status = 0
let body
if (tool === 'bash') {
  status = scenario === 'lease-denied' ? 1 : 0
} else if (tool === 'git') {
  const key = args.join(' ')
  if (key === 'rev-parse --git-common-dir') output = path.join(dir, 'repo', '.git') + '\\n'
  else if (key === 'rev-parse HEAD') output = '0'.repeat(40) + '\\n'
  else status = 97
} else {
  let cmd = args.slice(1)
  if (cmd[0] === '-n') cmd = cmd.slice(2)
  const server = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
  const name = server?.metadata.name
  const key = cmd.join(' ')
  if (cmd[0] === 'get' && cmd.at(-1) === 'name') {
    output = ''
  } else if (key === 'create -f - -o json') {
    body = JSON.parse(readFileSync(0, 'utf8'))
    body.metadata.uid = 'uid-cli'
    body.metadata.resourceVersion = '7'
    writeFileSync(statePath, JSON.stringify(body))
    output = JSON.stringify(body)
  } else if (cmd[0] === 'wait' || (cmd[0] === 'rollout' && !scenario.startsWith('rollout-'))) {
    output = ''
  } else if (cmd[0] === 'rollout' && scenario === 'rollout-fails') {
    process.stderr.write('PRIVATE-SUBPROCESS-OUTPUT\\n')
    output = 'PRIVATE-SUBPROCESS-OUTPUT\\n'
    status = 3
  } else if (cmd[0] === 'rollout') {
    record()
    // A child that handles SIGINT exits with a status; one that does not dies by the signal.
    if (scenario === 'rollout-handled-interrupt') process.on('SIGINT', () => process.exit(1))
    // Interrupt the probe's own process group, as a terminal interrupt would.
    process.kill(0, 'SIGINT')
    setTimeout(() => process.exit(98), 5000)
    return
  } else if (server && key === 'get deployment/' + name + ' -o json') {
    output = JSON.stringify({
      metadata: {
        name,
        namespace: 'mcp-server',
        labels: { 'clerum.io/managed-by': 'host-context-controller', 'clerum.io/mcpserver': name },
        ownerReferences: [
          { apiVersion: 'clerum.io/v1alpha1', kind: 'McpServer', name, uid: server.metadata.uid, controller: true },
        ],
      },
      spec: {
        template: {
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsUser: 1000 },
            containers: [
              {
                name: 'mcp-server',
                image: server.spec.image,
                command: server.spec.command,
                args: server.spec.args,
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              },
            ],
          },
        },
      },
    })
  } else if (server && key === 'get pods -l app=' + name + ' -o json') {
    output = JSON.stringify({
      items: [
        {
          metadata: { name: 'pod-a' },
          spec: { nodeName: 'node-a' },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
            containerStatuses: [
              { name: 'mcp-server', imageID: 'containerd://sha256:aaf77f4dcbb3d2cb71680f5608145cacaa2a75aa645f84f65cd179f364d5e710' },
            ],
          },
        },
      ],
    })
  } else if (key === 'get node node-a -o json') {
    output = JSON.stringify({ status: { nodeInfo: { architecture: 'amd64' } } })
  } else if (key === 'exec pod/pod-a -c mcp-server -- node --version') {
    output = 'v24.22.1\\n'
  } else if (key === 'exec -i pod/pod-a -c mcp-server -- node --input-type=commonjs -') {
    readFileSync(0, 'utf8')
    output = JSON.stringify({
      status: 'PASS',
      nodeVersion: '24.22.1',
      browserVersion: 'HeadlessChrome/130.0.0.0',
      navigation: true,
      realClick: true,
      screenshotBytes: 100,
      screenshotSha256: 'a'.repeat(64),
    })
  } else if (cmd[0] === 'get' && cmd[1] === 'mcpservers.clerum.io/' + name) {
    output = server ? JSON.stringify(server) : ''
  } else if (key.startsWith('get mcpservers.clerum.io/') && !server) {
    output = ''
  } else if (cmd[0] === 'delete' && server) {
    body = JSON.parse(readFileSync(0, 'utf8'))
    rmSync(statePath)
  } else {
    status = 97
  }
}
record(body)
process.stdout.write(output)
process.exit(status)
`

const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
const cliProfile = 'clerum-fix-playwright-1234abcd'

async function runCli(t, scenario) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'playwright-cluster-cli-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, 'bin')
  mkdirSync(bin)
  mkdirSync(path.join(directory, 'repo'))
  for (const tool of ['bash', 'git', 'kubectl']) {
    writeFileSync(path.join(bin, tool), `#!${process.execPath}\n${fakeTool}`, { mode: 0o755 })
  }
  // A new process group lets the interrupt scenario signal only this probe.
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'scripts/e2e/playwright-mcp-cluster-probe.mjs')],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: bin,
        T2_PROFILE: cliProfile,
        T2_CONTEXT: cliProfile,
        MINIKUBE_PROFILE: cliProfile,
        CONTROL_API_REAL_PG_CONTEXT: cliProfile,
        T2_PROJECT_DIR: repoRoot,
        PROBE_FAKE_DIR: directory,
        PROBE_FAKE_SCENARIO: scenario,
      },
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => (stdout += chunk))
  child.stderr.on('data', chunk => (stderr += chunk))
  const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 20_000)
  const [status, signal] = await once(child, 'close')
  clearTimeout(timer)
  const eventsPath = path.join(directory, 'events.jsonl')
  const events = existsSync(eventsPath)
    ? readFileSync(eventsPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    : []
  const runs = path.join(directory, 'repo/.local-notes/infra/runs')
  const runDirs = existsSync(runs) ? readdirSync(runs) : []
  const journalText =
    runDirs.length === 1
      ? readFileSync(path.join(runs, runDirs[0], 'journal.json'), 'utf8')
      : undefined
  const journal = journalText === undefined ? undefined : JSON.parse(journalText)
  return { status, signal, stdout, stderr, events, runDirs, journal, journalText }
}

const kubectlVerbs = events =>
  events.filter(item => item.tool === 'kubectl').map(item => item.args.slice(1).join(' '))

test('the CLI checks the lease first and passes the verified context to every kubectl call', async t => {
  const r = await runCli(t, 'pass')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^PLAYWRIGHT_MCP_CLUSTER_PASS architecture=amd64 evidence=/)
  assert.deepEqual(r.events[0], {
    tool: 'bash',
    args: [path.join(repoRoot, 'scripts/minikube/require-t2-mutation-lock.sh')],
  })
  const kubectl = r.events.filter(item => item.tool === 'kubectl')
  assert.ok(kubectl.length >= 10, `kubectl calls: ${kubectl.length}`)
  for (const call of kubectl) {
    assert.equal(call.args[0], `--context=${cliProfile}`, call.args.join(' '))
    assert.ok(!call.args.slice(1).some(arg => /^--(context|kubeconfig|cluster)/.test(arg)))
  }
  // Witnesses that the creation, runtime and deletion phases all ran.
  const verbs = kubectlVerbs(r.events)
  for (const pattern of [
    /^create -f - -o json$/,
    /rollout status deployment\/pwmcp[a-f0-9]{12}mcp/,
    /exec -i pod\/pod-a .* node --input-type=commonjs -$/,
    /^delete --raw \/apis\/clerum\.io\/v1alpha1\/namespaces\/mcp-server\/mcpservers\//,
  ])
    assert.ok(
      verbs.some(verb => pattern.test(verb)),
      pattern.source
    )
  const deleted = verbs.findIndex(verb => verb.startsWith('delete --raw'))
  assert.ok(
    verbs
      .slice(deleted + 1)
      .some(verb =>
        /get mcpservers\.clerum\.io\/pwmcp[a-f0-9]{12}mcp --ignore-not-found/.test(verb)
      ),
    'the deletion is verified by a later read'
  )
  const deletion = r.events.find(item => item.tool === 'kubectl' && item.args[1] === 'delete')
  assert.deepEqual(deletion.body.preconditions, { uid: 'uid-cli', resourceVersion: '7' })
  assert.equal(r.journal.complete, true)
  assert.equal(r.journal.resources[0].status, 'deleted')
  assert.equal(r.journal.residue, 'clear')
})

test('the CLI makes no git or kubectl call when the lease check fails', async t => {
  const r = await runCli(t, 'lease-denied')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /PLAYWRIGHT_MCP_CLUSTER_FAIL stage=preflight code=LEASE_INVALID\n$/)
  // The single bash event witnesses that the lease check ran.
  assert.deepEqual(
    r.events.map(item => item.tool),
    ['bash']
  )
  assert.deepEqual(r.runDirs, [])
})

for (const scenario of ['rollout-signal', 'rollout-handled-interrupt']) {
  test(`a group interrupt during rollout stops the runtime and deletes the owned server (${scenario})`, async t => {
    const r = await runCli(t, scenario)
    assert.equal(r.signal, null, 'the probe handles SIGINT instead of dying')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /PLAYWRIGHT_MCP_CLUSTER_FAIL stage=runtime code=PROBE_INTERRUPTED /)
    const verbs = kubectlVerbs(r.events)
    const rollout = verbs.findIndex(verb => verb.includes('rollout status'))
    const deletion = verbs.findIndex(verb => verb.startsWith('delete --raw'))
    assert.ok(rollout >= 0 && deletion > rollout, verbs.join('\n'))
    assert.equal(verbs.filter(verb => verb.includes(' exec ')).length, 0)
    for (const call of r.events.filter(item => item.tool === 'kubectl'))
      assert.equal(call.args[0], `--context=${cliProfile}`)
    assert.equal(r.journal.failure, 'PROBE_INTERRUPTED')
    assert.equal(r.journal.resources[0].status, 'deleted')
    assert.equal(r.journal.residue, 'clear')
  })
}

test('a failed rollout journals bounded detail without subprocess output and cleans up', async t => {
  const r = await runCli(t, 'rollout-fails')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /PLAYWRIGHT_MCP_CLUSTER_FAIL stage=runtime code=DEPLOYMENT_READY_FAILED /)
  // The rollout event and its exit status witness that the failing child ran.
  assert.ok(kubectlVerbs(r.events).some(verb => verb.includes('rollout status')))
  assert.equal(r.journal.failure, 'DEPLOYMENT_READY_FAILED')
  assert.deepEqual(r.journal.failureDetail, { status: 3, signal: null, error: null })
  assert.doesNotMatch(r.journalText, /PRIVATE-SUBPROCESS-OUTPUT/)
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE-SUBPROCESS-OUTPUT/)
  assert.equal(r.journal.resources[0].status, 'deleted')
  assert.equal(r.journal.residue, 'clear')
})

test('observes real termination signals after a blocking child before continuing', () => {
  const moduleUrl = new URL('./playwright-mcp-cluster-probe.mjs', import.meta.url).href
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const script = `
    import { spawnSync } from 'node:child_process'
    import { createSignalGuard } from ${JSON.stringify(moduleUrl)}
    const guard = createSignalGuard()
    process.kill(process.pid, ${JSON.stringify(signal)})
    const blocked = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'])
    if (blocked.status !== 0 || !(await guard.shouldStop())) process.exitCode = 1
    guard.close()
  `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(result.status, 0, result.stderr)
  }
})

test('a signal is not observed synchronously after a blocking child', () => {
  const script = `
    import { spawnSync } from 'node:child_process'
    let interrupted = false
    process.on('SIGTERM', () => { interrupted = true })
    process.kill(process.pid, 'SIGTERM')
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'])
    if (interrupted) process.exit(1)
    await new Promise(resolve => setImmediate(resolve))
    if (!interrupted) process.exitCode = 1
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(result.status, 0, result.stderr)
})

test('records bounded command failure metadata without subprocess output', () => {
  assert.throws(
    () =>
      command('fixture', [], {
        code: 'COMMAND_FIXTURE_FAILED',
        spawn: () => ({
          status: null,
          signal: 'SIGKILL',
          error: { code: 'ETIMEDOUT' },
          stderr: 'private diagnostic output',
        }),
      }),
    error => {
      assert.equal(error.code, 'COMMAND_FIXTURE_FAILED')
      assert.deepEqual(error.detail, { status: null, signal: 'SIGKILL', error: 'ETIMEDOUT' })
      assert.doesNotMatch(JSON.stringify(error), /private diagnostic output/)
      return true
    }
  )
})

test('distinguishes an interrupted child from a timed-out command', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    assert.throws(
      () =>
        command('fixture', [], {
          code: 'COMMAND_FIXTURE_FAILED',
          spawn: () => ({ status: null, signal }),
        }),
      error => error.code === 'PROBE_INTERRUPTED' && error.detail.signal === signal
    )
  }
  assert.throws(
    () =>
      command('fixture', [], {
        code: 'COMMAND_FIXTURE_FAILED',
        spawn: () => ({ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } }),
      }),
    error => error.code === 'COMMAND_FIXTURE_FAILED' && error.detail.error === 'ETIMEDOUT'
  )
})

test('a real SIGTERM stops the probe and cleans its owned fixture', () => {
  const moduleUrl = new URL('./playwright-mcp-cluster-probe.mjs', import.meta.url).href
  const script = `
    import { spawnSync } from 'node:child_process'
    import { createSignalGuard, makeFixtures, runOwnedProbe } from ${JSON.stringify(moduleUrl)}
    const runId = 'pw-mcp-0123456789ab'
    const resources = makeFixtures(${JSON.stringify(manifest)}, runId)
    const journal = { resources: [] }
    const guard = createSignalGuard()
    let created, removed = false
    try {
      await runOwnedProbe({
        resources, runId, journal, save: async () => {}, shouldStop: guard.shouldStop,
        create: async resource => {
          created = structuredClone(resource)
          created.metadata.uid = 'uid-test'
          created.metadata.resourceVersion = '42'
          return created
        },
        get: async () => created,
        remove: async () => { removed = true },
        wait: async () => null,
        verifyResidue: async () => {},
        run: async () => {
          process.kill(process.pid, 'SIGTERM')
          spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'])
          return {}
        },
      })
      process.exitCode = 1
    } catch (error) {
      if (error.code !== 'PROBE_INTERRUPTED' || !removed) process.exitCode = 1
    } finally {
      guard.close()
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(result.status, 0, result.stderr)
})

test('a failed journal sync removes its temporary file and permits a later save', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'playwright-cluster-journal-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let calls = 0
  const save = journalWriter(directory, { state: 'owned' }, () => {
    if (calls++ === 0) throw new Error('synthetic journal sync failure')
  })
  await assert.rejects(save(), /synthetic journal sync failure/)
  assert.equal(existsSync(path.join(directory, 'journal.next')), false)
  await save()
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'journal.json'), 'utf8')), {
    state: 'owned',
  })
})

function harness() {
  const journal = { resources: [] }
  const live = new Map()
  const events = []
  return {
    journal,
    live,
    events,
    options: {
      resources,
      runId,
      journal,
      save: async () => events.push(['save', structuredClone(journal.resources)]),
      create: async resource => {
        const entry = journal.resources.at(-1)
        assert.equal(entry.status, 'creation-pending')
        const created = structuredClone(resource)
        created.metadata.uid = `uid-${resource.kind}`
        created.metadata.resourceVersion = '42'
        live.set(resource.kind, created)
        events.push(['create', resource.kind])
        return created
      },
      get: async entry => live.get(entry.kind) ?? null,
      remove: async request => {
        assert.equal(request.body.propagationPolicy, 'Foreground')
        events.push(['delete', request.path, request.body.preconditions])
        live.delete('McpServer')
      },
      wait: async entry => live.get(entry.kind) ?? null,
      verifyResidue: async () => events.push(['residue']),
      run: async () => {
        events.push(['runtime'])
        return { status: 'checked' }
      },
    },
  }
}

test('requires Node 24 and the exact inherited profile and worktree', () => {
  const repoRoot = realpathSync(process.cwd())
  const profile = 'clerum-fix-playwright-1234abcd'
  const env = {
    T2_PROFILE: profile,
    T2_CONTEXT: profile,
    MINIKUBE_PROFILE: profile,
    CONTROL_API_REAL_PG_CONTEXT: profile,
    T2_PROJECT_DIR: repoRoot,
  }
  assert.equal(assertLane(env, repoRoot, '24.22.1'), profile)
  for (const bad of [
    { ...env, T2_CONTEXT: 'other' },
    { ...env, MINIKUBE_PROFILE: 'other' },
    { ...env, CONTROL_API_REAL_PG_CONTEXT: 'other' },
    { ...env, T2_PROJECT_DIR: '/' },
  ])
    assert.throws(() => assertLane(bad, repoRoot, '24.22.1'), /LANE_IDENTITY_INVALID/)
  assert.throws(() => assertLane(env, repoRoot, '22.22.0'), /LANE_IDENTITY_INVALID/)
})

test('creates only a run-owned McpServer and preserves the manifest runtime', () => {
  assert.deepEqual(
    resources.map(item => item.kind),
    ['McpServer']
  )
  assert.equal('contextRef' in resources[0].spec, false)
  assert.equal(resources[0].spec.image, image)
  assert.deepEqual(resources[0].spec.command, manifest.spec.command)
  assert.deepEqual(resources[0].spec.args, manifest.spec.args)
  assert.equal(manifest.spec.transport.url, 'http://fixture')
  assert.throws(
    () => makeFixtures({ ...manifest, spec: { ...manifest.spec, image: 'wrong' } }, runId),
    /MANIFEST_INVALID/
  )
  assert.throws(() => makeFixtures(manifest, '../other'), /MANIFEST_INVALID/)
})

test('the probe accepts the checked-in Playwright manifest', () => {
  const require = createRequire(
    new URL('../../host-context-controller/package.json', import.meta.url)
  )
  const actual = require('yaml').parse(
    readFileSync(new URL('../../mcp-servers/playwright/mcpserver.yaml', import.meta.url), 'utf8')
  )
  assert.doesNotThrow(() => makeFixtures(actual, runId))
})

test('accepts only the approved image index or matching architecture digest', () => {
  const index = image.split('@')[1]
  const arm = 'sha256:6402f88ad9f26102e910f5412cf5f09c5cfdc6bc7ff2eb277d334f43a4f457e0'
  assert.equal(imageIdentity(image, 'arm64', `containerd://${arm}`), arm)
  assert.equal(imageIdentity(image, 'amd64', `docker-pullable://fixture@${index}`), index)
  assert.throws(() => imageIdentity(image, 'amd64', `containerd://${arm}`), /POD_IMAGE_INVALID/)
  assert.throws(() => imageIdentity(image, 'unknown', `containerd://${index}`), /POD_IMAGE_INVALID/)
  assert.throws(() => imageIdentity('other', 'arm64', `containerd://${arm}`), /POD_IMAGE_INVALID/)
})

test('rejects a deployment that drifts from the manifest or hardened runtime', () => {
  const serverName = resources[0].metadata.name
  const serverUid = 'uid-McpServer'
  const container = {
    name: 'mcp-server',
    image,
    command: manifest.spec.command,
    args: manifest.spec.args,
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
  }
  const pod = {
    containers: [container],
    securityContext: { runAsUser: 1000 },
    automountServiceAccountToken: false,
  }
  const deployment = {
    metadata: {
      name: serverName,
      namespace: 'mcp-server',
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/mcpserver': serverName,
      },
      ownerReferences: [
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'McpServer',
          name: serverName,
          uid: serverUid,
          controller: true,
        },
      ],
    },
    spec: { template: { spec: pod } },
  }
  assert.doesNotThrow(() => assertDeployment(deployment, manifest, serverName, serverUid))
  container.image = 'other'
  assert.throws(
    () => assertDeployment(deployment, manifest, serverName, serverUid),
    /DEPLOYMENT_MISMATCH/
  )
  container.image = image
  pod.automountServiceAccountToken = true
  assert.throws(
    () => assertDeployment(deployment, manifest, serverName, serverUid),
    /DEPLOYMENT_MISMATCH/
  )
  pod.automountServiceAccountToken = false
  deployment.metadata.ownerReferences[0].uid = 'different-server'
  assert.throws(
    () => assertDeployment(deployment, manifest, serverName, serverUid),
    /DEPLOYMENT_MISMATCH/
  )
  deployment.metadata.ownerReferences[0].uid = serverUid
  deployment.metadata.ownerReferences[0].controller = false
  assert.throws(
    () => assertDeployment(deployment, manifest, serverName, serverUid),
    /DEPLOYMENT_MISMATCH/
  )
  deployment.metadata.ownerReferences[0].controller = true
  pod.securityContext.runAsUser = 0
  assert.throws(
    () => assertDeployment(deployment, manifest, serverName, serverUid),
    /DEPLOYMENT_MISMATCH/
  )
  pod.securityContext.runAsUser = 1000
  container.securityContext.allowPrivilegeEscalation = true
  assert.throws(
    () => assertDeployment(deployment, manifest, serverName, serverUid),
    /DEPLOYMENT_MISMATCH/
  )
  container.securityContext.allowPrivilegeEscalation = false
  container.securityContext.capabilities.drop = ['NET_RAW']
  assert.throws(
    () => assertDeployment(deployment, manifest, serverName, serverUid),
    /DEPLOYMENT_MISMATCH/
  )
  container.securityContext.capabilities.drop = ['ALL']
  assert.doesNotThrow(() => assertDeployment(deployment, manifest, serverName, serverUid))
})

test('records creation and deletes the owned McpServer with UID and resourceVersion', async () => {
  const h = harness()
  assert.deepEqual(await runOwnedProbe(h.options), { status: 'checked' })
  const deletes = h.events.filter(item => item[0] === 'delete')
  assert.equal(deletes.length, 1)
  assert.match(deletes[0][1], /\/mcpservers\//)
  assert.deepEqual(deletes[0][2], { uid: 'uid-McpServer', resourceVersion: '42' })
  assert.equal(h.journal.resources[0].resourceVersion, '42')
  assert.equal(h.journal.resources[0].deleteResourceVersion, '42')
  assert.deepEqual(
    h.journal.resources.map(entry => entry.status),
    ['deleted']
  )
})

test('does not guess the UID after an ambiguous create', async () => {
  const h = harness()
  h.options.create = async () => {
    throw new Error('response lost')
  }
  await assert.rejects(runOwnedProbe(h.options), /RESOURCE_CREATION_AMBIGUOUS/)
  assert.equal(h.journal.resources[0].status, 'creation-pending')
  assert.equal(h.events.filter(item => item[0] === 'delete').length, 0)
})

test('cleans a confirmed UID after a transient journal failure', async () => {
  const h = harness()
  const save = h.options.save
  let attempts = 0
  h.options.save = async () => {
    if (++attempts === 2) throw new Error('journal unavailable')
    await save()
  }
  await assert.rejects(runOwnedProbe(h.options), /journal unavailable/)
  const deletionIntent = h.events.findIndex(
    item => item[0] === 'save' && item[1][0]?.status === 'deletion-pending'
  )
  const deletion = h.events.findIndex(item => item[0] === 'delete')
  assert.ok(deletionIntent >= 0 && deletion > deletionIntent)
  assert.deepEqual(h.events[deletion][2], { uid: 'uid-McpServer', resourceVersion: '42' })
  assert.equal(h.journal.resources[0].status, 'deleted')
})

test('does not delete a confirmed UID if the deletion intent cannot be saved', async () => {
  const h = harness()
  const save = h.options.save
  let attempts = 0
  h.options.save = async () => {
    if (++attempts >= 2) throw new Error('journal unavailable')
    await save()
  }
  await assert.rejects(runOwnedProbe(h.options), /CLEANUP_FAILED/)
  assert.equal(h.events.filter(item => item[0] === 'create').length, 1)
  assert.equal(h.events.filter(item => item[0] === 'delete').length, 0)
})

test('does not classify an intent save failure as an ambiguous create', async () => {
  const h = harness()
  h.options.save = async () => {
    throw new Error('journal unavailable')
  }
  await assert.rejects(runOwnedProbe(h.options), /journal unavailable/)
  assert.equal(h.events.filter(item => item[0] === 'create').length, 0)
  assert.deepEqual(h.journal.resources, [])
})

test('never deletes a replaced or relabeled resource', async () => {
  const current = structuredClone(resources[0])
  current.metadata.uid = 'replacement'
  current.metadata.resourceVersion = '42'
  const entry = { kind: 'McpServer', name: current.metadata.name, uid: 'original' }
  assert.throws(() => deleteRequest(entry, current, runId), /RESOURCE_IDENTITY_CHANGED/)
  current.metadata.uid = 'original'
  current.metadata.labels['evenfire.ai/e2e-run'] = 'other'
  assert.throws(() => deleteRequest(entry, current, runId), /RESOURCE_IDENTITY_INVALID/)
})

test('fails cleanup if the owned McpServer still exists after deletion', async () => {
  const h = harness()
  h.options.wait = async () => resources[0]
  await assert.rejects(runOwnedProbe(h.options), /CLEANUP_FAILED/)
  assert.equal(h.events.filter(item => item[0] === 'delete').length, 1)
  assert.equal(h.events.filter(item => item[0] === 'residue').length, 0)
  assert.equal(h.journal.cleanupFailure, 'RESOURCE_DELETE_UNVERIFIED')
  assert.equal(h.journal.resources[0].status, 'deletion-pending')
})

test('refuses a new fixture when an earlier server or workload remains', () => {
  assert.doesNotThrow(() => assertNoResidue(() => ''))
  assert.throws(
    () =>
      assertNoResidue(args =>
        args.some(arg => arg === 'mcpservers.clerum.io')
          ? 'mcpserver.clerum.io/pwmcp0123456789abmcp\n'
          : ''
      ),
    /RESIDUE_PRESENT/
  )
  assert.throws(
    () =>
      assertNoResidue(args =>
        args.includes('deployments,services,pods,replicasets,networkpolicies')
          ? 'pod/pwmcp0123456789abmcp-abc\n'
          : ''
      ),
    /RESIDUE_PRESENT/
  )
  for (const namespace of ['mcp-server', 'mcp-host', 'rpc-proxy']) {
    assert.throws(
      () =>
        assertNoResidue(args =>
          args[1] === namespace && args.some(arg => arg.split(',').includes('networkpolicies'))
            ? 'networkpolicy.networking.k8s.io/pwmcp0123456789abmcp-policy\n'
            : ''
        ),
      /RESIDUE_PRESENT/
    )
  }
})

test('cleans owned resources after a runtime failure and reports the failure', async () => {
  const h = harness()
  h.options.run = async () => {
    throw new Error('runtime failed')
  }
  await assert.rejects(runOwnedProbe(h.options), /runtime failed/)
  assert.equal(h.events.filter(item => item[0] === 'delete').length, 1)
  assert.equal(h.events.filter(item => item[0] === 'residue').length, 1)
})

test('stops before runtime and cleans the owned server when interrupted', async () => {
  const h = harness()
  const create = h.options.create
  let interrupted = false
  h.options.create = async resource => {
    const created = await create(resource)
    interrupted = true
    return created
  }
  h.options.shouldStop = () => interrupted
  await assert.rejects(runOwnedProbe(h.options), /PROBE_INTERRUPTED/)
  assert.equal(h.events.filter(item => item[0] === 'runtime').length, 0)
  assert.equal(h.events.filter(item => item[0] === 'delete').length, 1)
})

test('does not create a server when interrupted after recording intent', async () => {
  const h = harness()
  let checks = 0
  h.options.shouldStop = () => ++checks === 2
  await assert.rejects(runOwnedProbe(h.options), /PROBE_INTERRUPTED/)
  assert.equal(h.events.filter(item => item[0] === 'create').length, 0)
  assert.deepEqual(h.journal.resources, [])
})

test('records the original failure if cleanup also fails', async () => {
  const h = harness()
  h.options.run = async () => {
    throw new Error('runtime failed')
  }
  h.options.remove = async () => {
    throw new Error('delete failed')
  }
  await assert.rejects(runOwnedProbe(h.options), /CLEANUP_FAILED/)
  assert.equal(h.journal.failure, 'LOCAL_ERROR')
  assert.equal(h.journal.cleanupFailure, 'LOCAL_ERROR')
})

test('does not pass while HCC-derived policies remain', async () => {
  const h = harness()
  h.options.verifyResidue = async () => {
    throw new Error('policy remains')
  }
  await assert.rejects(runOwnedProbe(h.options), /CLEANUP_FAILED/)
  assert.equal(h.events.filter(item => item[0] === 'delete').length, 1)
})

test('checks only the fixture server policies and waits for their deletion', () => {
  let present = true
  const calls = []
  const kubectl = args => {
    calls.push(args)
    assert.equal(
      args[args.indexOf('-l') + 1],
      'clerum.io/managed-by=host-context-controller,clerum.io/mcpserver=pwmcp0123456789abmcp'
    )
    if (args[1] !== 'mcp-server') return ''
    if (args[2] === 'wait') {
      present = false
      return ''
    }
    return present ? 'networkpolicy/fixture\n' : ''
  }
  verifyPolicyCleanup(kubectl, resources[0].metadata.name)
  assert.equal(calls.filter(args => args[2] === 'wait').length, 1)
  assert.equal(
    calls.some(args => args.includes('delete')),
    false
  )
  assert.throws(
    () =>
      verifyPolicyCleanup(() => {
        throw new Error('API unavailable')
      }, resources[0].metadata.name),
    /API unavailable/
  )
})

test('checks that the fixture Deployment and pods disappear after deleting the server', () => {
  const present = { deployment: true, pods: true }
  const calls = []
  const kubectl = args => {
    calls.push(args)
    const kind = args.includes('pods') ? 'pods' : 'deployment'
    if (args[2] === 'wait') present[kind] = false
    return present[kind] ? `${kind}/fixture\n` : ''
  }
  verifyWorkloadCleanup(kubectl, resources[0].metadata.name)
  assert.equal(calls.filter(args => args[2] === 'wait').length, 2)
  assert.equal(
    calls.some(args => args.includes('delete')),
    false
  )
  assert.throws(
    () => verifyWorkloadCleanup(() => 'pod/remaining\n', resources[0].metadata.name),
    /WORKLOAD_CLEANUP_FAILED/
  )
})

test('requires actual runtime evidence and rejects empty or malformed reports', () => {
  const pass = {
    status: 'PASS',
    nodeVersion: '24.22.1',
    browserVersion: 'HeadlessChrome/146.0.0.0',
    navigation: true,
    realClick: true,
    screenshotBytes: 128,
    screenshotSha256: 'a'.repeat(64),
  }
  assert.deepEqual(runtimeReport(JSON.stringify(pass)), pass)
  for (const bad of [
    '',
    '{}',
    JSON.stringify({ ...pass, realClick: false }),
    JSON.stringify({ ...pass, screenshotBytes: 0 }),
    JSON.stringify({ ...pass, screenshotSha256: 'not-a-digest' }),
    JSON.stringify({ ...pass, nodeVersion: '22.22.0' }),
    JSON.stringify({ ...pass, browserVersion: 'other' }),
  ])
    assert.throws(() => runtimeReport(bad), /RUNTIME_REPORT_INVALID/)
})
