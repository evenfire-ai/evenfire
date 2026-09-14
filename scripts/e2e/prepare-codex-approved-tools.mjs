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

function command(executable, args, { input, timeout = 60_000, inherit = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd: repo,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  })
  // Subprocess output can include runtime state. Only callers parse their
  // specific safe result; never embed raw stderr/stdout in an exception.
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`${path.basename(executable)} operation failed`)
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
  command('bash', ['scripts/minikube/require-t2-mutation-lock.sh'])
  const evidence = validateRunDirectory(
    required('APPROVED_TOOLS_CANONICAL_ROOT'),
    required('APPROVED_TOOLS_EVIDENCE_DIR')
  )
  const statePath = path.join(evidence, 'fixture-state.json')
  const kc = args => ['--context=' + profile, '--request-timeout=30s', ...args]
  const kubectl = (args, options) => command('kubectl', kc(args), options)
  const head = command('git', ['rev-parse', 'HEAD']).trim()
  const ownerLibrary = path.join(repo, 'scripts/minikube/port-forward-owner.sh')
  const owner = (fn, args) =>
    command('bash', [
      '-c',
      'source "$1"; shift; fn="$1"; shift; "$fn" "$@"',
      'pf-owner',
      ownerLibrary,
      fn,
      ...args,
    ])
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
  const save = () =>
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
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
    if (fs.lstatSync(statePath).isSymbolicLink()) throw new Error('Unsafe state file')
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    await restore()
    return
  }
  if (required('APPROVED_TOOLS_UPSTREAM_MODE') !== 'deterministic')
    throw new Error(
      'Synthetic preparation is deterministic-only; real accounts require separate authorized preconditions'
    )
  if (fs.existsSync(statePath))
    throw new Error('Fresh fixture run required; restore previous run explicitly')
  const seedFile = path.join(
    repo,
    'tests/e2e/fixtures/codex-subscription/approved-tools-setup/seed.mjs'
  )
  const seedSource = fs.readFileSync(seedFile, 'utf8')
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
  const profilePidDirectory = fs.realpathSync(
    path.join(required('T2_PROFILE_ROOT'), profile, 'pids')
  )
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
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  async function startForward(namespace, service, localPort, remotePort, health, accept) {
    const record = path.join(profilePidDirectory, `${run}-${service}.pid`)
    const log = fs.openSync(path.join(evidence, `pf-${service}.log`), 'wx', 0o600)
    const child = spawn(
      'kubectl',
      [
        `--context=${profile}`,
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
      command(process.execPath, ['scripts/e2e/run-codex-approved-tools.mjs'], {
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
