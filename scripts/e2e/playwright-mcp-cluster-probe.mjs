import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
const image =
  'ghcr.io/evenfire-ai/playwright-server@sha256:fc603bbc05d216ca9394940463e5e216d0a48732c24555fb9b67d20775fccf73'
const imageDigests = {
  amd64: [
    'sha256:aaf77f4dcbb3d2cb71680f5608145cacaa2a75aa645f84f65cd179f364d5e710',
    'sha256:c92230dc8f4237be978b4ec0894af6f98a8e8a95272121e7550f995512f211a6',
  ],
  arm64: [
    'sha256:6402f88ad9f26102e910f5412cf5f09c5cfdc6bc7ff2eb277d334f43a4f457e0',
    'sha256:54af073f37a176bd1f1dbb2fb496d669221c7e39f98e234a1cc57b0290f9f225',
  ],
}
const kinds = { McpServer: 'mcpservers' }

class ProbeFailure extends Error {
  constructor(code, stage, detail) {
    super(code)
    this.code = code
    this.stage = stage
    this.detail = detail
  }
}

function fail(code) {
  throw new ProbeFailure(code)
}

export function createSignalGuard() {
  let interrupted = false
  const onSignal = () => {
    interrupted = true
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return {
    async shouldStop() {
      // spawnSync blocks the main event loop; give queued signals a turn.
      await new Promise(resolve => setImmediate(resolve))
      return interrupted
    },
    close() {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    },
  }
}

export function assertLane(env, repoRoot, nodeVersion) {
  const profile = env.T2_PROFILE
  if (
    !/^24\./.test(nodeVersion ?? '') ||
    !profile ||
    env.T2_CONTEXT !== profile ||
    env.MINIKUBE_PROFILE !== profile ||
    env.CONTROL_API_REAL_PG_CONTEXT !== profile
  )
    fail('LANE_IDENTITY_INVALID')
  try {
    if (!env.T2_PROJECT_DIR || realpathSync(env.T2_PROJECT_DIR) !== repoRoot) {
      fail('LANE_IDENTITY_INVALID')
    }
  } catch {
    fail('LANE_IDENTITY_INVALID')
  }
  return profile
}

export function makeFixtures(manifest, runId) {
  if (
    !/^pw-mcp-[a-f0-9]{12}$/.test(runId ?? '') ||
    manifest?.apiVersion !== 'clerum.io/v1alpha1' ||
    manifest.kind !== 'McpServer' ||
    manifest.metadata?.namespace !== 'mcp-server' ||
    manifest.spec?.image !== image ||
    JSON.stringify(manifest.spec.command) !== JSON.stringify(['node']) ||
    !Array.isArray(manifest.spec.args) ||
    manifest.spec.args[0] !== 'cli.js' ||
    manifest.spec.transport?.type !== 'streamableHttp' ||
    manifest.spec.transport.port !== 8931
  )
    fail('MANIFEST_INVALID')

  const server = `pwmcp${runId.slice('pw-mcp-'.length)}mcp`
  const labels = { 'evenfire.ai/e2e-suite': 'playwright-mcp', 'evenfire.ai/e2e-run': runId }
  const spec = structuredClone(manifest.spec)
  // A unique reference is enough for HCC to create the server; this probe
  // connects inside the pod and does not need to create a Context.
  spec.contextRef = `${runId}-ctx`
  spec.transport.url = `http://${server}.mcp-server.svc.cluster.local:8931/mcp`
  return [
    {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'McpServer',
      metadata: { name: server, namespace: 'mcp-server', labels },
      spec,
    },
  ]
}

function identity(resource, runId) {
  const expectedName =
    resource?.kind === 'McpServer' ? `pwmcp${runId.slice('pw-mcp-'.length)}mcp` : ''
  if (
    !/^pw-mcp-[a-f0-9]{12}$/.test(runId ?? '') ||
    !expectedName ||
    resource.apiVersion !== 'clerum.io/v1alpha1' ||
    resource.metadata?.name !== expectedName ||
    resource.metadata.namespace !== 'mcp-server' ||
    resource.metadata.labels?.['evenfire.ai/e2e-suite'] !== 'playwright-mcp' ||
    resource.metadata.labels?.['evenfire.ai/e2e-run'] !== runId
  )
    fail('RESOURCE_IDENTITY_INVALID')
  return { kind: resource.kind, name: expectedName }
}

export function imageIdentity(manifestImage, architecture, imageId) {
  const digest = /(?:^|@|\/\/)(sha256:[a-f0-9]{64})$/.exec(imageId ?? '')?.[1]
  const index = image.split('@')[1]
  if (
    manifestImage !== image ||
    !Object.hasOwn(imageDigests, architecture ?? '') ||
    !digest ||
    ![index, ...imageDigests[architecture]].includes(digest)
  )
    fail('POD_IMAGE_INVALID')
  return digest
}

export function assertNoResidue(kubectl) {
  const servers = kubectl([
    '-n',
    'mcp-server',
    'get',
    'mcpservers.clerum.io',
    '-l',
    'evenfire.ai/e2e-suite=playwright-mcp',
    '-o',
    'name',
  ])
  if (servers.trim()) fail('RESIDUE_PRESENT')
  const checks = [
    ['mcp-server', 'deployments,services,pods,replicasets,networkpolicies'],
    ['mcp-host', 'networkpolicies'],
    ['rpc-proxy', 'networkpolicies'],
  ]
  for (const [namespace, kinds] of checks) {
    const names = kubectl([
      '-n',
      namespace,
      'get',
      kinds,
      '-l',
      'clerum.io/mcpserver',
      '-o',
      'name',
    ])
    if (/(?:^|[^a-z0-9])pwmcp[a-f0-9]{12}mcp(?:[^a-z0-9]|$)/m.test(names)) {
      fail('RESIDUE_PRESENT')
    }
  }
}

export function deleteRequest(entry, current, runId) {
  const observed = identity(current, runId)
  if (
    entry.kind !== observed.kind ||
    entry.name !== observed.name ||
    !entry.uid ||
    current.metadata.uid !== entry.uid ||
    typeof current.metadata.resourceVersion !== 'string' ||
    !current.metadata.resourceVersion
  )
    fail('RESOURCE_IDENTITY_CHANGED')
  return {
    path: `/apis/clerum.io/v1alpha1/namespaces/mcp-server/${kinds[entry.kind]}/${entry.name}`,
    body: {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      propagationPolicy: 'Foreground',
      preconditions: { uid: entry.uid, resourceVersion: current.metadata.resourceVersion },
    },
  }
}

// The callbacks are the Kubernetes boundary. Only an authenticated NotFound is null.
export async function runOwnedProbe({
  resources,
  runId,
  journal,
  save,
  create,
  get,
  remove,
  wait,
  verifyResidue,
  shouldStop = () => false,
  run,
}) {
  if (
    !Array.isArray(resources) ||
    resources.length !== 1 ||
    identity(resources[0], runId).kind !== 'McpServer' ||
    !Array.isArray(journal.resources) ||
    journal.resources.length !== 0 ||
    typeof verifyResidue !== 'function' ||
    typeof shouldStop !== 'function'
  )
    fail('RESOURCE_PLAN_INVALID')

  let failure
  let result
  try {
    if (await shouldStop()) fail('PROBE_INTERRUPTED')
    for (const resource of resources) {
      const entry = { ...identity(resource, runId), status: 'creation-pending' }
      journal.resources.push(entry)
      try {
        await save()
      } catch (error) {
        journal.resources.pop()
        throw error
      }
      if (await shouldStop()) {
        journal.resources.pop()
        await save()
        fail('PROBE_INTERRUPTED')
      }
      const created = await create(resource)
      if (
        JSON.stringify(identity(created, runId)) !== JSON.stringify(identity(resource, runId)) ||
        typeof created.metadata.uid !== 'string' ||
        !created.metadata.uid ||
        typeof created.metadata.resourceVersion !== 'string' ||
        !created.metadata.resourceVersion
      )
        fail('RESOURCE_CREATE_UNVERIFIED')
      entry.uid = created.metadata.uid
      entry.resourceVersion = created.metadata.resourceVersion
      entry.status = 'created'
      await save()
      if (await shouldStop()) fail('PROBE_INTERRUPTED')
    }
    result = await run()
    if (await shouldStop()) fail('PROBE_INTERRUPTED')
  } catch (error) {
    failure = error
    journal.failure = error instanceof ProbeFailure ? error.code : 'LOCAL_ERROR'
    if (error instanceof ProbeFailure && error.detail) journal.failureDetail = error.detail
    try {
      await save()
    } catch {
      // Cleanup still requires its own successful journal writes.
    }
  }

  if (journal.resources.some(entry => entry.status === 'creation-pending')) {
    fail('RESOURCE_CREATION_AMBIGUOUS')
  }
  try {
    for (const entry of [...journal.resources].reverse()) {
      const current = await get(entry)
      if (current !== null) {
        const request = deleteRequest(entry, current, runId)
        entry.status = 'deletion-pending'
        entry.deleteResourceVersion = request.body.preconditions.resourceVersion
        await save()
        await remove(request)
        if ((await wait(entry)) !== null) fail('RESOURCE_DELETE_UNVERIFIED')
      }
      entry.status = 'deleted'
      await save()
    }
    if (journal.resources.length > 0) {
      journal.residue = 'verification-pending'
      await save()
      await verifyResidue()
      journal.residue = 'clear'
      await save()
    }
  } catch (error) {
    journal.cleanupFailure = error instanceof ProbeFailure ? error.code : 'LOCAL_ERROR'
    if (error instanceof ProbeFailure && error.detail) journal.cleanupDetail = error.detail
    try {
      await save()
    } catch {
      // Preserve the original cleanup failure when the journal is unavailable.
    }
    throw new ProbeFailure('CLEANUP_FAILED', 'cleanup')
  }
  if (failure) throw failure
  if (await shouldStop()) {
    journal.failure = 'PROBE_INTERRUPTED'
    await save()
    fail('PROBE_INTERRUPTED')
  }
  return result
}

function waitUntilGone(kubectl, getArgs, waitArgs, code) {
  const get = () => kubectl(getArgs).trim()
  if (!get()) return
  try {
    kubectl(waitArgs, undefined, 100_000, code)
  } catch (error) {
    if (get()) throw error
  }
  if (get()) fail(code)
}

export function verifyPolicyCleanup(kubectl, server) {
  if (!/^pwmcp[a-f0-9]{12}mcp$/.test(server ?? '')) fail('RESOURCE_IDENTITY_INVALID')
  const selector = `clerum.io/managed-by=host-context-controller,clerum.io/mcpserver=${server}`
  for (const namespace of ['mcp-server', 'mcp-host', 'rpc-proxy']) {
    waitUntilGone(
      kubectl,
      ['-n', namespace, 'get', 'networkpolicies', '-l', selector, '-o', 'name'],
      ['-n', namespace, 'wait', '--for=delete', 'networkpolicies', '-l', selector, '--timeout=90s'],
      'POLICY_CLEANUP_FAILED'
    )
  }
}

export function verifyWorkloadCleanup(kubectl, server) {
  if (!/^pwmcp[a-f0-9]{12}mcp$/.test(server ?? '')) fail('RESOURCE_IDENTITY_INVALID')
  const selector = `app=${server}`
  waitUntilGone(
    kubectl,
    ['-n', 'mcp-server', 'get', `deployment/${server}`, '--ignore-not-found', '-o', 'name'],
    ['-n', 'mcp-server', 'wait', '--for=delete', `deployment/${server}`, '--timeout=90s'],
    'WORKLOAD_CLEANUP_FAILED'
  )
  waitUntilGone(
    kubectl,
    ['-n', 'mcp-server', 'get', 'pods', '-l', selector, '-o', 'name'],
    ['-n', 'mcp-server', 'wait', '--for=delete', 'pods', '-l', selector, '--timeout=90s'],
    'WORKLOAD_CLEANUP_FAILED'
  )
}

export function runtimeReport(raw) {
  let report
  try {
    report = JSON.parse(raw)
  } catch {
    fail('RUNTIME_REPORT_INVALID')
  }
  if (
    report?.status !== 'PASS' ||
    report.nodeVersion !== '24.22.1' ||
    !/^(?:HeadlessChrome|Chrome)\/[0-9]+(?:\.[0-9]+)+$/.test(report.browserVersion ?? '') ||
    report.navigation !== true ||
    report.realClick !== true ||
    !Number.isInteger(report.screenshotBytes) ||
    report.screenshotBytes < 8 ||
    !/^[a-f0-9]{64}$/.test(report.screenshotSha256 ?? '')
  )
    fail('RUNTIME_REPORT_INVALID')
  return report
}

export function command(
  executable,
  args,
  { input, timeout = 30_000, code = 'COMMAND_FAILED', spawn = spawnSync } = {}
) {
  const result = spawn(executable, args, {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0) {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGQUIT']
    const errors = [
      'EACCES',
      'EAGAIN',
      'ENOENT',
      'EPERM',
      'ETIMEDOUT',
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    ]
    const failureCode = ['SIGINT', 'SIGTERM'].includes(result.signal) ? 'PROBE_INTERRUPTED' : code
    throw new ProbeFailure(failureCode, undefined, {
      status:
        Number.isInteger(result.status) && result.status >= 0 && result.status <= 255
          ? result.status
          : null,
      signal: signals.includes(result.signal) ? result.signal : null,
      error: errors.includes(result.error?.code)
        ? result.error.code
        : result.error
          ? 'OTHER'
          : null,
    })
  }
  return result.stdout
}

function json(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    fail('COMMAND_JSON_INVALID')
  }
}

export function journalWriter(directory, journal, sync = fsyncSync) {
  const temporary = path.join(directory, 'journal.next')
  const target = path.join(directory, 'journal.json')
  return async () => {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      try {
        writeFileSync(fd, `${JSON.stringify(journal)}\n`)
        sync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

export function assertDeployment(deployment, manifest, serverName, serverUid) {
  const pod = deployment.spec?.template?.spec
  const container = pod?.containers?.find(item => item.name === 'mcp-server')
  const owner = deployment.metadata?.ownerReferences?.find(
    item =>
      item.apiVersion === 'clerum.io/v1alpha1' &&
      item.kind === 'McpServer' &&
      item.name === serverName &&
      item.uid === serverUid &&
      item.controller === true
  )
  if (
    !serverUid ||
    deployment.metadata?.name !== serverName ||
    deployment.metadata?.namespace !== 'mcp-server' ||
    deployment.metadata?.labels?.['clerum.io/managed-by'] !== 'host-context-controller' ||
    deployment.metadata?.labels?.['clerum.io/mcpserver'] !== serverName ||
    !owner ||
    container?.image !== manifest.spec.image ||
    JSON.stringify(container.command) !== JSON.stringify(manifest.spec.command) ||
    JSON.stringify(container.args) !== JSON.stringify(manifest.spec.args) ||
    container.securityContext?.allowPrivilegeEscalation !== false ||
    !container.securityContext?.capabilities?.drop?.includes('ALL') ||
    pod.securityContext?.runAsUser !== 1000 ||
    pod.automountServiceAccountToken !== false
  )
    fail('DEPLOYMENT_MISMATCH')
}

async function inspectPod(kubectl, server, manifest, serverUid, shouldStop) {
  const checkedKubectl = async (...args) => {
    if (await shouldStop()) fail('PROBE_INTERRUPTED')
    try {
      const output = kubectl(...args)
      if (await shouldStop()) fail('PROBE_INTERRUPTED')
      return output
    } catch (error) {
      if (await shouldStop()) fail('PROBE_INTERRUPTED')
      throw error
    }
  }
  await checkedKubectl(
    ['-n', 'mcp-server', 'wait', '--for=create', `deployment/${server}`, '--timeout=180s'],
    undefined,
    190_000,
    'DEPLOYMENT_CREATE_FAILED'
  )
  await checkedKubectl(
    ['-n', 'mcp-server', 'rollout', 'status', `deployment/${server}`, '--timeout=600s'],
    undefined,
    610_000,
    'DEPLOYMENT_READY_FAILED'
  )
  const deployment = json(
    await checkedKubectl(['-n', 'mcp-server', 'get', `deployment/${server}`, '-o', 'json'])
  )
  assertDeployment(deployment, manifest, server, serverUid)
  const pods = json(
    await checkedKubectl(['-n', 'mcp-server', 'get', 'pods', '-l', `app=${server}`, '-o', 'json'])
  )
  const ready = (pods.items ?? []).filter(pod =>
    pod.status?.conditions?.some(row => row.type === 'Ready' && row.status === 'True')
  )
  if (ready.length !== 1) fail('POD_NOT_UNIQUE')
  const pod = ready[0]
  const podName = pod.metadata?.name
  const nodeName = pod.spec?.nodeName
  if (
    ![podName, nodeName].every(
      name => typeof name === 'string' && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)
    )
  )
    fail('POD_IDENTITY_INVALID')
  const node = json(await checkedKubectl(['get', 'node', nodeName, '-o', 'json']))
  const architecture = node.status?.nodeInfo?.architecture
  const digest = imageIdentity(
    manifest.spec.image,
    architecture,
    pod.status?.containerStatuses?.find(item => item.name === 'mcp-server')?.imageID
  )
  const version = (
    await checkedKubectl([
      '-n',
      'mcp-server',
      'exec',
      `pod/${podName}`,
      '-c',
      'mcp-server',
      '--',
      'node',
      '--version',
    ])
  ).trim()
  if (version !== 'v24.22.1') fail('POD_NODE_INVALID')
  return { podName, architecture, digest, version }
}

async function main() {
  let runDir
  let stage = 'preflight'
  let journal
  let save
  const signals = createSignalGuard()
  try {
    const profile = assertLane(process.env, root, process.versions.node)
    command('bash', [path.join(root, 'scripts/minikube/require-t2-mutation-lock.sh')], {
      code: 'LEASE_INVALID',
    })
    const require = createRequire(path.join(root, 'host-context-controller/package.json'))
    const manifest = require('yaml').parse(
      readFileSync(path.join(root, 'mcp-servers/playwright/mcpserver.yaml'), 'utf8')
    )
    const runtime = readFileSync(
      path.join(root, 'scripts/e2e/test/playwright-mcp-cluster-runtime.cjs'),
      'utf8'
    )
    const runId = `pw-mcp-${randomBytes(6).toString('hex')}`
    const resources = makeFixtures(manifest, runId)
    const common = command('git', ['rev-parse', '--git-common-dir'], {
      code: 'GIT_IDENTITY_FAILED',
    }).trim()
    const primary = realpathSync(path.dirname(path.resolve(root, common)))
    const evidenceRoot = path.join(primary, '.local-notes/infra/runs')
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
    runDir = mkdtempSync(path.join(evidenceRoot, `${runId}-`))
    chmodSync(runDir, 0o700)
    journal = {
      runId,
      profile,
      gitHead: command('git', ['rev-parse', 'HEAD']).trim(),
      resources: [],
    }
    save = journalWriter(runDir, journal)
    await save()
    const kubectl = (args, input, timeout = 30_000, code = 'KUBECTL_FAILED') =>
      command('kubectl', [`--context=${profile}`, ...args], { input, timeout, code })
    assertNoResidue(kubectl)
    const get = entry => {
      const out = kubectl([
        '-n',
        'mcp-server',
        'get',
        `${kinds[entry.kind]}.clerum.io/${entry.name}`,
        '--ignore-not-found',
        '-o',
        'json',
      ])
      return out.trim() ? json(out) : null
    }
    stage = 'fixture'
    const result = await runOwnedProbe({
      resources,
      runId,
      journal,
      save,
      create: async resource =>
        json(
          kubectl(
            ['create', '-f', '-', '-o', 'json'],
            JSON.stringify(resource),
            30_000,
            'RESOURCE_CREATE_FAILED'
          )
        ),
      get,
      remove: async request => {
        kubectl(
          ['delete', '--raw', request.path, '-f', '-'],
          JSON.stringify(request.body),
          30_000,
          'RESOURCE_DELETE_FAILED'
        )
      },
      wait: async entry => {
        if (get(entry) === null) return null
        try {
          kubectl(
            [
              '-n',
              'mcp-server',
              'wait',
              '--for=delete',
              `${kinds[entry.kind]}.clerum.io/${entry.name}`,
              '--timeout=90s',
            ],
            undefined,
            100_000,
            'RESOURCE_WAIT_FAILED'
          )
        } catch (error) {
          if (get(entry) === null) return null
          throw error
        }
        return get(entry)
      },
      verifyResidue: async () => {
        verifyWorkloadCleanup(kubectl, resources[0].metadata.name)
        verifyPolicyCleanup(kubectl, resources[0].metadata.name)
      },
      shouldStop: signals.shouldStop,
      run: async () => {
        stage = 'runtime'
        const pod = await inspectPod(
          kubectl,
          resources[0].metadata.name,
          manifest,
          journal.resources[0].uid,
          signals.shouldStop
        )
        if (await signals.shouldStop()) fail('PROBE_INTERRUPTED')
        const report = runtimeReport(
          kubectl(
            [
              '-n',
              'mcp-server',
              'exec',
              '-i',
              `pod/${pod.podName}`,
              '-c',
              'mcp-server',
              '--',
              'node',
              '--input-type=commonjs',
              '-',
            ],
            runtime,
            150_000,
            'RUNTIME_FAILED'
          )
        )
        if (await signals.shouldStop()) fail('PROBE_INTERRUPTED')
        journal.runtime = {
          architecture: pod.architecture,
          digest: pod.digest,
          nodeVersion: pod.version,
          browserVersion: report.browserVersion,
          screenshotBytes: report.screenshotBytes,
          screenshotSha256: report.screenshotSha256,
        }
        await save()
        return journal.runtime
      },
    })
    if (await signals.shouldStop()) fail('PROBE_INTERRUPTED')
    journal.complete = true
    await save()
    if (await signals.shouldStop()) {
      journal.complete = false
      journal.failure = 'PROBE_INTERRUPTED'
      await save()
      fail('PROBE_INTERRUPTED')
    }
    process.stdout.write(
      `PLAYWRIGHT_MCP_CLUSTER_PASS architecture=${result.architecture} evidence=${runDir}\n`
    )
  } catch (error) {
    if (journal && save && !journal.failure) {
      journal.failure = error instanceof ProbeFailure ? error.code : 'LOCAL_ERROR'
      if (error instanceof ProbeFailure && error.detail) journal.failureDetail = error.detail
      try {
        await save()
      } catch {
        // The console still reports the failure if the journal is unavailable.
      }
    }
    process.stderr.write(
      `PLAYWRIGHT_MCP_CLUSTER_FAIL stage=${error instanceof ProbeFailure && error.stage ? error.stage : stage} code=${error instanceof ProbeFailure ? error.code : 'LOCAL_ERROR'}${runDir ? ` evidence=${runDir}` : ''}\n`
    )
    process.exitCode = 1
  } finally {
    signals.close()
  }
}

function invokedAsMain() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

if (invokedAsMain()) await main()
