import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sizes = [83, 150, 250]
const fixtureImage = 'clerum/codex-approved-tools-mcp-e2e:test'
const proxyImage = 'clerum/codex-approved-tools-proxy-e2e:test'
const proxyFlags = [
  'CODEX_APPROVED_TOOLS_TEST_ONLY',
  'CODEX_APPROVED_TOOLS_MINIKUBE_PROFILE',
  'NODE_ENV',
]

export function makeScenarios(run, ports, probePort) {
  if (!/^approved-tools-[a-f0-9]{12}$/.test(run)) throw new Error('Invalid fixture run identity')
  if (
    ports.length !== 3 ||
    new Set([...ports, probePort]).size !== 4 ||
    [...ports, probePort].some(p => !Number.isInteger(p) || p < 1024 || p > 65535)
  )
    throw new Error('Invalid fixture ports')
  return sizes.map((catalogSize, index) => ({
    catalogSize,
    runId: `${run}-${catalogSize}`,
    agentName: `${run}-agent-${catalogSize}`,
    agentDisplayName: `Codex tools ${catalogSize} ${run}`,
    contextName: `${run}-context-${catalogSize}`,
    connectorName: `${run}-mcp-${catalogSize}`,
    subscriptionName: `Codex fixture ${catalogSize} ${run}`,
    connectionKey: `${run}-grant-${catalogSize}`,
    modelName: 'gpt-5.3-codex',
    modelLabel: 'Codex isolated tool test',
    fixtureUrl: `http://127.0.0.1:${ports[index]}`,
    upstreamEvidenceUrl: `http://127.0.0.1:${probePort}`,
  }))
}

export function makeResources(scenarios) {
  return scenarios.flatMap(s => {
    const labels = {
      'evenfire.ai/e2e-suite': 'codex-approved-tools',
      'evenfire.ai/e2e-run': s.runId,
    }
    return [
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Context',
        metadata: { name: s.contextName, namespace: 'mcp-server', labels },
        spec: { contextId: s.contextName, mcpServers: [] },
      },
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Host',
        metadata: { name: s.agentName, namespace: 'mcp-host', labels },
        spec: {
          host: s.agentDisplayName,
          contextRef: s.contextName,
          model: { provider: 'codex-subscription', name: s.modelName, connectionRef: 'unassigned' },
          channels: [],
        },
      },
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'McpServer',
        metadata: { name: s.connectorName, namespace: 'mcp-server', labels },
        spec: {
          contextRef: s.contextName,
          image: fixtureImage,
          imagePullPolicy: 'Never',
          enabled: true,
          description: `Isolated approved-tools catalog ${s.catalogSize}`,
          transport: {
            type: 'streamableHttp',
            url: `http://${s.connectorName}.mcp-server.svc.cluster.local:8080/mcp`,
            port: 8080,
          },
          healthCheck: { port: 8080 },
          auth: { type: 'none' },
          env: [
            { name: 'CATALOG_SIZE', value: String(s.catalogSize) },
            { name: 'RUN_ID', value: s.runId },
            { name: 'BIND_ADDRESS', value: '0.0.0.0' },
          ],
          resources: {
            requests: { cpu: '10m', memory: '32Mi' },
            limits: { cpu: '200m', memory: '128Mi' },
          },
        },
      },
    ]
  })
}

export function assertResourceRoundTrip(expected, observed) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed) || observed.length !== expected.length)
      throw new Error('Fixture array was not preserved by the API server')
    expected.forEach((item, index) => assertResourceRoundTrip(item, observed[index]))
  } else if (expected && typeof expected === 'object') {
    if (!observed || typeof observed !== 'object')
      throw new Error('Fixture object was not preserved by the API server')
    for (const [key, value] of Object.entries(expected))
      assertResourceRoundTrip(value, observed[key])
  } else if (expected !== observed)
    throw new Error('Fixture field was not preserved by the API server')
}

// All reads and state writes use the opened descriptor, not a path reopened
// after a check. Nonblocking open lets us reject FIFOs without hanging.
export function openOwnedFile(
  root,
  name,
  { create = false, writable = false, maxBytes = 4 * 1024 * 1024 } = {}
) {
  if (path.basename(name) !== name || !name || name === '.' || name === '..')
    throw new Error('Expected a single owned filename')
  const directory = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  )
  try {
    const parent = fs.fstatSync(directory)
    if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o022)
      throw new Error('Unsafe owner directory')
    const fd = fs.openSync(
      path.join(root, name),
      (writable || create ? fs.constants.O_RDWR : fs.constants.O_RDONLY) |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK |
        (create ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0),
      0o600
    )
    try {
      const stat = fs.fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== parent.uid ||
        stat.mode & 0o022 ||
        stat.size > maxBytes
      )
        throw new Error('Unsafe or oversized owned file')
      return { fd, dev: stat.dev, ino: stat.ino, maxBytes }
    } catch (error) {
      fs.closeSync(fd)
      throw error
    }
  } finally {
    fs.closeSync(directory)
  }
}

export function readOwnedDescriptor(file) {
  const before = fs.fstatSync(file.fd)
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.dev !== file.dev ||
    before.ino !== file.ino ||
    before.size > file.maxBytes
  )
    throw new Error('Owned file changed')
  const buffer = Buffer.alloc(file.maxBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    const count = fs.readSync(file.fd, buffer, offset, buffer.length - offset, offset)
    if (!count) break
    offset += count
  }
  const after = fs.fstatSync(file.fd)
  if (
    offset > file.maxBytes ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    after.nlink !== 1
  )
    throw new Error('Owned file changed or exceeds its byte budget')
  return buffer.subarray(0, offset).toString('utf8')
}

export function readOwnedFile(root, name, maxBytes) {
  const file = openOwnedFile(root, name, { maxBytes })
  try {
    return readOwnedDescriptor(file)
  } finally {
    fs.closeSync(file.fd)
  }
}

export function validateProfile(profile) {
  if (
    typeof profile !== 'string' ||
    !/^clerum-[a-z0-9-]+-[a-f0-9]{7,8}$/.test(profile) ||
    profile.length > 100
  )
    throw new Error('Invalid owned profile')
  return profile
}

export function validateOwnerArgs(args, recording, profile, pidDirectory) {
  validateProfile(profile)
  if (args.length !== (recording ? 9 : 8)) throw new Error('Invalid owner argument count')
  const [record, ...tail] = args
  if (recording && !/^[1-9][0-9]{0,9}$/.test(tail.shift())) throw new Error('Invalid child PID')
  const [target, context, worktree, namespace, service, localPort, remotePort] = tail
  if (
    target !== profile ||
    context !== profile ||
    worktree !== repo ||
    !['control-plane', 'mcp-server'].includes(namespace) ||
    !/^(codex-llm-proxy|approved-tools-[a-f0-9]{12}-mcp-(83|150|250))$/.test(service)
  )
    throw new Error('Invalid owner binding')
  if (
    !/^[0-9]{4,5}$/.test(localPort) ||
    Number(localPort) < 1024 ||
    Number(localPort) > 65535 ||
    remotePort !== (namespace === 'control-plane' ? '9090' : '8080')
  )
    throw new Error('Invalid owner port')
  if (
    path.dirname(record) !== pidDirectory ||
    !/^approved-tools-[a-f0-9]{12}-(codex-llm-proxy|approved-tools-[a-f0-9]{12}-mcp-(83|150|250))\.pid$/.test(
      path.basename(record)
    )
  )
    throw new Error('Invalid owner record path')
  return args
}

export function validateKubectlArgs(args, profile) {
  if (args[0] !== `--context=${validateProfile(profile)}` || args[1] !== '--request-timeout=30s')
    throw new Error('Invalid kubectl context or timeout')
  const operation = args.slice(2)
  const exact = allowed => JSON.stringify(operation) === JSON.stringify(allowed)
  if (
    exact(['create', '--dry-run=server', '-f', '-', '-o', 'json']) ||
    exact(['create', '-f', '-', '-o', 'json'])
  )
    return args
  const [flag, namespace, verb, resource] = operation
  if (flag !== '-n' || !['control-plane', 'mcp-host', 'mcp-server'].includes(namespace))
    throw new Error('Unsupported namespace')
  if (
    verb === 'get' &&
    operation.length === 6 &&
    operation[4] === '-o' &&
    operation[5] === 'json' &&
    ((namespace === 'control-plane' &&
      ['deployment/codex-llm-proxy', 'service/codex-llm-proxy'].includes(resource)) ||
      (namespace === 'mcp-host' && resource === 'configmap/mcp-host-config'))
  )
    return args
  if (
    operation.length === 6 &&
    operation[5] === '--timeout=180s' &&
    ((verb === 'rollout' && resource === 'status') ||
      (verb === 'wait' && resource === '--for=create')) &&
    ((namespace === 'control-plane' && operation[4] === 'deployment/codex-llm-proxy') ||
      (namespace === 'mcp-server' &&
        /^deployment\/approved-tools-[a-f0-9]{12}-mcp-(83|150|250)$/.test(operation[4])))
  )
    return args
  if (
    namespace === 'control-plane' &&
    verb === 'patch' &&
    resource === 'deployment/codex-llm-proxy' &&
    operation.length === 7 &&
    operation[4] === '--type=strategic' &&
    operation[5] === '-p'
  ) {
    const patch = JSON.parse(operation[6])
    const entries = patch?.spec?.template?.spec?.containers
    if (!Array.isArray(entries) || entries.length !== 1) throw new Error('Invalid proxy patch')
    const c = entries[0]
    if (
      c.name !== 'codex-llm-proxy' ||
      !/^(clerum\/codex-(llm-proxy|approved-tools-proxy-e2e)|ghcr\.io\/evenfire-ai\/codex-llm-proxy)(:[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/.test(
        c.image
      ) ||
      !['Always', 'IfNotPresent', 'Never'].includes(c.imagePullPolicy)
    )
      throw new Error('Invalid proxy image')
    if (
      !Array.isArray(c.env) ||
      c.env.length !== 3 ||
      new Set(c.env.map(e => e.name)).size !== 3 ||
      c.env.some(
        e =>
          !proxyFlags.includes(e.name) ||
          Object.keys(e).length !== 2 ||
          (e.$patch !== 'delete' &&
            !(e.name === 'NODE_ENV'
              ? ['production', 'development', 'test'].includes(e.value)
              : e.name === 'CODEX_APPROVED_TOOLS_TEST_ONLY'
                ? e.value === '1'
                : e.value === profile))
      )
    )
      throw new Error('Invalid proxy environment')
    const normalized = {
      spec: {
        template: {
          spec: {
            containers: [
              { name: c.name, image: c.image, imagePullPolicy: c.imagePullPolicy, env: c.env },
            ],
          },
        },
      },
    }
    if (JSON.stringify(normalized) !== JSON.stringify(patch))
      throw new Error('Unexpected proxy patch fields')
    return args
  }
  // Remote Node programs are fixed feature probes or the bounded repository
  // seed, never selected through environment variables or an arbitrary path.
  if (namespace === 'control-plane' && verb === 'exec') {
    if (
      operation.length === 8 &&
      operation[4] === '--' &&
      operation[5] === 'node' &&
      operation[6] === '-e'
    ) {
      const keys =
        resource === 'deployment/control-api'
          ? ['CONTROL_API_CODEX_SUBSCRIPTION_ENABLED', 'CODEX_LLM_PROXY_EXECUTION_ENABLED']
          : resource === 'deployment/codex-llm-proxy'
            ? ['CODEX_LLM_PROXY_EXECUTION_ENABLED']
            : null
      if (
        keys &&
        operation[7] ===
          `process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.every(key => process.env[key] === 'true')))`
      )
        return args
    }
    if (
      operation.length === 10 &&
      resource === '-i' &&
      operation[4] === 'deployment/control-api' &&
      operation[5] === '--' &&
      operation[6] === 'node' &&
      operation[7] === '--input-type=module' &&
      operation[8] === '--eval' &&
      operation[9] ===
        readOwnedFile(
          path.join(repo, 'tests/e2e/fixtures/codex-subscription/approved-tools-setup'),
          'seed.mjs',
          128 * 1024
        )
    )
      return args
  }
  throw new Error('Unsupported kubectl operation')
}

function command(operation, args, { input, timeout = 60_000, inherit = false } = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      ['BASH_ENV', 'ENV', 'SHELLOPTS', 'CDPATH', 'NODE_OPTIONS', 'NODE_PATH'].includes(key) ||
      key.startsWith('BASH_FUNC_')
    )
      delete env[key]
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 25 * 60_000)
    throw new Error('Invalid deadline')
  const options = {
    cwd: repo,
    env,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  }
  let result
  switch (operation) {
    case 'lease':
      result = spawnSync('bash', ['scripts/minikube/require-t2-mutation-lock.sh'], options)
      break
    case 'head':
      result = spawnSync('git', ['rev-parse', 'HEAD'], options)
      break
    case 'kubectl':
      result = spawnSync(
        'kubectl',
        validateKubectlArgs(args, required('MINIKUBE_PROFILE')),
        options
      )
      break
    case 'pf_owner_record_process':
      result = spawnSync(
        'bash',
        ['scripts/e2e/codex-approved-tools-pf-owner.sh', 'record', ...args],
        options
      )
      break
    case 'pf_owner_record_process_matches':
      result = spawnSync(
        'bash',
        ['scripts/e2e/codex-approved-tools-pf-owner.sh', 'matches', ...args],
        options
      )
      break
    case 'pf_owner_cleanup_record':
      result = spawnSync(
        'bash',
        ['scripts/e2e/codex-approved-tools-pf-owner.sh', 'cleanup', ...args],
        options
      )
      break
    case 'runner':
      result = spawnSync(
        process.execPath,
        [
          'scripts/minikube/run-with-deadline.mjs',
          '--timeout-seconds',
          '1500',
          '--kill-grace-seconds',
          '5',
          '--label',
          'approved-tools-runner',
          '--',
          process.execPath,
          'scripts/e2e/run-codex-approved-tools.mjs',
        ],
        { ...options, timeout: 1_520_000 }
      )
      break
    default:
      throw new Error('Unsupported fixture process')
  }
  // Subprocess output can include runtime state. Only callers parse their
  // specific safe result; never embed raw stderr/stdout in an exception.
  if (result.error || result.signal || result.status !== 0)
    throw new Error('Bounded fixture operation failed')
  return result.stdout ?? ''
}

function required(key) {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  return port
}

async function waitHttp(url, accept) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok && accept(await response.json())) return
    } catch {
      /* bounded readiness polling of a freshly started owned process */
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Fixture readiness deadline exceeded')
}

export function validateRunDirectory(canonical, evidence) {
  const root = fs.realpathSync(path.join(canonical, '.local-notes/infra/runs'))
  if (path.relative(fs.realpathSync(canonical), root) !== '.local-notes/infra/runs')
    throw new Error('Unsafe canonical evidence root')
  const resolved = fs.realpathSync(evidence)
  if (path.dirname(resolved) !== root || fs.lstatSync(evidence).isSymbolicLink())
    throw new Error('Evidence must be a dedicated canonical run directory')
  return resolved
}

async function main() {
  process.umask(0o077)
  if (!process.version.startsWith('v24.')) throw new Error('Node24 is required')
  const action = process.argv[2] ?? 'prepare'
  if (!['prepare', 'run', 'restore'].includes(action))
    throw new Error('Expected prepare, run, or restore')
  const profile = required('MINIKUBE_PROFILE')
  if (
    profile !== required('CONTROL_API_REAL_PG_CONTEXT') ||
    !/^clerum-.+-[a-f0-9]{7,8}$/.test(profile)
  )
    throw new Error('Owned branch Minikube context required')
  command('lease', [])
  const evidence = validateRunDirectory(
    required('APPROVED_TOOLS_CANONICAL_ROOT'),
    required('APPROVED_TOOLS_EVIDENCE_DIR')
  )
  const kc = args => ['--context=' + profile, '--request-timeout=30s', ...args]
  const kubectl = (args, options) => command('kubectl', kc(args), options)
  const head = command('head', []).trim()
  const profilePidDirectory = fs.realpathSync(
    path.join(required('T2_PROFILE_ROOT'), profile, 'pids')
  )
  const owner = (fn, args) => {
    if (
      ![
        'pf_owner_record_process',
        'pf_owner_record_process_matches',
        'pf_owner_cleanup_record',
      ].includes(fn)
    )
      throw new Error('Invalid owner function')
    return command(
      fn,
      validateOwnerArgs(args, fn === 'pf_owner_record_process', profile, profilePidDirectory)
    )
  }
  const validateForward = binding => {
    owner('pf_owner_record_process_matches', [
      binding.record,
      profile,
      profile,
      repo,
      binding.namespace,
      binding.service,
      String(binding.localPort),
      String(binding.remotePort),
    ])
  }
  let state
  let stateFile
  const save = () => {
    // An interrupted in-place write may be incomplete. Restoration then fails
    // JSON validation; it never guesses the previous image or deletes records.
    // The existing descriptor prevents a replacement path redirecting writes.
    const data = Buffer.from(JSON.stringify(state, null, 2) + '\n')
    if (data.length > stateFile.maxBytes || fs.fstatSync(stateFile.fd).nlink !== 1)
      throw new Error('Invalid state write')
    fs.ftruncateSync(stateFile.fd, 0)
    fs.writeSync(stateFile.fd, data, 0, data.length, 0)
    fs.fsyncSync(stateFile.fd)
  }
  async function restore() {
    if (!state || state.profile !== profile || state.worktree !== repo || state.head !== head)
      throw new Error('Fixture ownership mismatch')
    const deployment = JSON.parse(
      kubectl(['-n', 'control-plane', 'get', 'deployment/codex-llm-proxy', '-o', 'json'])
    )
    const container = deployment.spec.template.spec.containers.find(
      c => c.name === 'codex-llm-proxy'
    )
    if (deployment.metadata.uid !== state.proxyUid || !container)
      throw new Error('Proxy deployment ownership changed')
    if (container.image === proxyImage) {
      const env = proxyFlags.map(name => ({ name, $patch: 'delete' }))
      if (state.originalNodeEnv) env[2] = state.originalNodeEnv
      kubectl([
        '-n',
        'control-plane',
        'patch',
        'deployment/codex-llm-proxy',
        '--type=strategic',
        '-p',
        JSON.stringify({
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: 'codex-llm-proxy',
                    image: state.originalProxyImage,
                    imagePullPolicy: state.originalImagePullPolicy,
                    env,
                  },
                ],
              },
            },
          },
        }),
      ])
      kubectl(
        [
          '-n',
          'control-plane',
          'rollout',
          'status',
          'deployment/codex-llm-proxy',
          '--timeout=180s',
        ],
        { timeout: 190_000 }
      )
    } else if (container.image !== state.originalProxyImage)
      throw new Error('Refusing to restore an unrelated proxy image')
    for (const binding of state.forwards) {
      owner('pf_owner_cleanup_record', [
        binding.record,
        profile,
        profile,
        repo,
        binding.namespace,
        binding.service,
        String(binding.localPort),
        String(binding.remotePort),
      ])
    }
    state.restored = true
    save()
  }
  if (action === 'restore') {
    stateFile = openOwnedFile(evidence, 'fixture-state.json', { writable: true })
    try {
      state = JSON.parse(readOwnedDescriptor(stateFile))
      await restore()
    } finally {
      fs.closeSync(stateFile.fd)
    }
    return
  }
  if (required('APPROVED_TOOLS_UPSTREAM_MODE') !== 'deterministic')
    throw new Error(
      'Synthetic preparation is deterministic-only; real accounts require separate authorized preconditions'
    )
  const seedFile = path.join(
    repo,
    'tests/e2e/fixtures/codex-subscription/approved-tools-setup/seed.mjs'
  )
  const seedSource = readOwnedFile(path.dirname(seedFile), path.basename(seedFile), 128 * 1024)
  for (const name of [
    'TEST_ADMIN_USERNAME',
    'TEST_ADMIN_PASSWORD',
    'TEST_USER_EMAIL',
    'TEST_USER_PASSWORD',
  ])
    required(name)
  // The supported Minikube overlays enable these already. Refuse a stale or
  // differently configured runtime; fixture setup must not weaken feature gates.
  for (const [deploymentName, keys] of [
    [
      'control-api',
      ['CONTROL_API_CODEX_SUBSCRIPTION_ENABLED', 'CODEX_LLM_PROXY_EXECUTION_ENABLED'],
    ],
    ['codex-llm-proxy', ['CODEX_LLM_PROXY_EXECUTION_ENABLED']],
  ]) {
    const check = `process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.every(key => process.env[key] === 'true')))`
    if (
      kubectl([
        '-n',
        'control-plane',
        'exec',
        `deployment/${deploymentName}`,
        '--',
        'node',
        '-e',
        check,
      ]).trim() !== 'true'
    )
      throw new Error('Codex Minikube feature gates are not enabled in the running workload')
  }
  const hostFlags = JSON.parse(
    kubectl(['-n', 'mcp-host', 'get', 'configmap/mcp-host-config', '-o', 'json'])
  )
  if (hostFlags.data?.MCP_HOST_CODEX_SUBSCRIPTION_ENABLED !== 'true')
    throw new Error('Host Codex feature gate is not enabled by the Minikube overlay')
  const run = 'approved-tools-' + randomBytes(6).toString('hex')
  const ports = []
  while (ports.length < 4) {
    const port = await freePort()
    if (!ports.includes(port)) ports.push(port)
  }
  const scenarios = makeScenarios(run, ports.slice(0, 3), ports[3])
  const resources = makeResources(scenarios)
  const proposed = { apiVersion: 'v1', kind: 'List', items: resources }
  const validated = JSON.parse(
    kubectl(['create', '--dry-run=server', '-f', '-', '-o', 'json'], {
      input: JSON.stringify(proposed),
    })
  )
  assertResourceRoundTrip(resources, validated.items)
  const proxyService = JSON.parse(
    kubectl(['-n', 'control-plane', 'get', 'service/codex-llm-proxy', '-o', 'json'])
  )
  if (!proxyService.spec.ports.some(p => p.port === 9090))
    throw new Error('Proxy probe Service port is missing')
  const deployment = JSON.parse(
    kubectl(['-n', 'control-plane', 'get', 'deployment/codex-llm-proxy', '-o', 'json'])
  )
  const container = deployment.spec.template.spec.containers.find(c => c.name === 'codex-llm-proxy')
  if (
    !container ||
    container.image === proxyImage ||
    (container.env ?? []).some(e => proxyFlags.slice(0, 2).includes(e.name))
  )
    throw new Error('Proxy already has test ownership')
  const originalNodeEnv = container.env?.find(e => e.name === 'NODE_ENV')
  if (originalNodeEnv && !['production', 'development', 'test'].includes(originalNodeEnv.value))
    throw new Error('Unsupported explicit NODE_ENV binding')
  state = {
    profile,
    worktree: repo,
    head,
    run,
    scenarios,
    forwards: [],
    resources: resources.map(r => ({
      kind: r.kind,
      name: r.metadata.name,
      namespace: r.metadata.namespace,
    })),
    originalProxyImage: container.image,
    originalImagePullPolicy: container.imagePullPolicy,
    originalNodeEnv,
    proxyUid: deployment.metadata.uid,
    restored: false,
  }
  stateFile = openOwnedFile(evidence, 'fixture-state.json', { create: true })
  save()
  async function startForward(namespace, service, localPort, remotePort, health, accept) {
    const record = path.join(profilePidDirectory, `${run}-${service}.pid`)
    validateOwnerArgs(
      [record, profile, profile, repo, namespace, service, String(localPort), String(remotePort)],
      false,
      profile,
      profilePidDirectory
    )
    const log = fs.openSync(path.join(evidence, `pf-${service}.log`), 'wx', 0o600)
    const child = spawn(
      'kubectl',
      [
        `--context=${validateProfile(profile)}`,
        '-n',
        namespace,
        'port-forward',
        '--address=127.0.0.1',
        `svc/${service}`,
        `${localPort}:${remotePort}`,
      ],
      { cwd: repo, detached: true, stdio: ['ignore', log, log] }
    )
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
    fs.closeSync(log)
    const binding = { record, namespace, service, localPort, remotePort }
    try {
      owner('pf_owner_record_process', [
        record,
        String(child.pid),
        profile,
        profile,
        repo,
        namespace,
        service,
        String(localPort),
        String(remotePort),
      ])
    } catch (error) {
      child.kill('SIGTERM')
      throw error
    }
    state.forwards.push(binding)
    save()
    await waitHttp(health, accept)
    validateForward(binding)
  }
  try {
    const created = JSON.parse(
      kubectl(['create', '-f', '-', '-o', 'json'], { input: JSON.stringify(proposed) })
    )
    assertResourceRoundTrip(resources, created.items)
    kubectl([
      '-n',
      'control-plane',
      'patch',
      'deployment/codex-llm-proxy',
      '--type=strategic',
      '-p',
      JSON.stringify({
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'codex-llm-proxy',
                  image: proxyImage,
                  imagePullPolicy: 'Never',
                  env: [
                    { name: 'NODE_ENV', value: 'test' },
                    { name: 'CODEX_APPROVED_TOOLS_TEST_ONLY', value: '1' },
                    { name: 'CODEX_APPROVED_TOOLS_MINIKUBE_PROFILE', value: profile },
                  ],
                },
              ],
            },
          },
        },
      }),
    ])
    kubectl(
      ['-n', 'control-plane', 'rollout', 'status', 'deployment/codex-llm-proxy', '--timeout=180s'],
      { timeout: 190_000 }
    )
    await startForward(
      'control-plane',
      'codex-llm-proxy',
      ports[3],
      9090,
      `${scenarios[0].upstreamEvidenceUrl}/approved-tools/evidence`,
      value => Array.isArray(value.requests)
    )
    for (const [index, scenario] of scenarios.entries()) {
      kubectl(
        [
          '-n',
          'mcp-server',
          'wait',
          '--for=create',
          `deployment/${scenario.connectorName}`,
          '--timeout=180s',
        ],
        { timeout: 190_000 }
      )
      kubectl(
        [
          '-n',
          'mcp-server',
          'rollout',
          'status',
          `deployment/${scenario.connectorName}`,
          '--timeout=180s',
        ],
        { timeout: 190_000 }
      )
      await startForward(
        'mcp-server',
        scenario.connectorName,
        ports[index],
        8080,
        `${scenario.fixtureUrl}/health`,
        value =>
          value.ready === true &&
          value.catalogSize === scenario.catalogSize &&
          value.runId === scenario.runId
      )
    }
    const seedInput = {
      mode: 'deterministic',
      profile,
      scenarios,
      userDisplayName: run,
      adminUsername: required('TEST_ADMIN_USERNAME'),
      adminPassword: required('TEST_ADMIN_PASSWORD'),
      userEmail: required('TEST_USER_EMAIL'),
      userPassword: required('TEST_USER_PASSWORD'),
    }
    kubectl(
      [
        '-n',
        'control-plane',
        'exec',
        '-i',
        'deployment/control-api',
        '--',
        'node',
        '--input-type=module',
        '--eval',
        seedSource,
      ],
      { input: JSON.stringify(seedInput), timeout: 90_000 }
    )
    fs.writeFileSync(
      path.join(evidence, 'scenarios.json'),
      JSON.stringify(scenarios, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
    state.ready = true
    save()
    if (action === 'run') {
      process.env.APPROVED_TOOLS_SCENARIOS = JSON.stringify(scenarios)
      command('runner', [], {
        timeout: 25 * 60_000,
        inherit: true,
      })
      await restore()
    }
    process.stdout.write(
      `${JSON.stringify({ fixture: 'ready', mode: 'deterministic', scenariosFile: path.join(evidence, 'scenarios.json'), restored: state.restored })}\n`
    )
  } catch (error) {
    try {
      await restore()
    } catch {
      process.stderr.write(
        'Fixture restore failed; use the explicit restore target before another gate\n'
      )
    }
    throw error
  } finally {
    fs.closeSync(stateFile.fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write(
      'Approved tools preparation failed; review bounded sanitized fixture evidence\n'
    )
    process.exitCode = 1
  })
}
