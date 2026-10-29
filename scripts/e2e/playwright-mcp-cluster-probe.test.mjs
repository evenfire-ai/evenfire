import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertDeployment,
  assertLane,
  assertNoResidue,
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
    contextRef: 'context1',
    transport: { type: 'streamableHttp', url: 'http://fixture', port: 8931 },
  },
}
const resources = makeFixtures(manifest, runId)

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
  assert.equal(resources[0].spec.contextRef, `${runId}-ctx`)
  assert.equal(resources[0].spec.image, image)
  assert.deepEqual(resources[0].spec.command, manifest.spec.command)
  assert.deepEqual(resources[0].spec.args, manifest.spec.args)
  assert.equal(manifest.spec.contextRef, 'context1')
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

test('does not delete when the original UID could not be saved', async () => {
  const h = harness()
  const save = h.options.save
  let attempts = 0
  h.options.save = async () => {
    if (++attempts === 2) throw new Error('journal unavailable')
    await save()
  }
  await assert.rejects(runOwnedProbe(h.options), /RESOURCE_CREATION_AMBIGUOUS/)
  assert.equal(h.events.filter(item => item[0] === 'delete').length, 0)
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

test('refuses a new fixture when an earlier server or workload remains', () => {
  assert.doesNotThrow(() => assertNoResidue(() => ''))
  assert.throws(
    () =>
      assertNoResidue(args =>
        args.some(arg => arg === 'mcpservers.clerum.io') ? 'mcpserver/pwmcp0123456789abmcp\n' : ''
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
    JSON.stringify({ ...pass, nodeVersion: '22.22.0' }),
    JSON.stringify({ ...pass, browserVersion: 'other' }),
  ])
    assert.throws(() => runtimeReport(bad), /RUNTIME_REPORT_INVALID/)
})
