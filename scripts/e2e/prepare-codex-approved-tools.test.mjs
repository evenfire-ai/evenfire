import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  IMAGES,
  localRef,
  minikubeVerifyRefs,
  publishedImages,
  pullInGhcrMode,
} from '../release/images-manifest.mjs'
import {
  APPROVED_TOOLS_SUITES,
  assertResourceRoundTrip,
  identityFailureMessage,
  isIdentityFailureMessage,
  makeResources,
  makeScenarios,
  makeWorkflowResources,
  makeWorkflowScenario,
  openOwnedFile,
  parseDryRunItems,
  parseIdentityFailure,
  readOwnedDescriptor,
  readOwnedFile,
  validateKubectlArgs,
  validateOwnerArgs,
  validateProfile,
  validateProxyImage,
  validateRunDirectory,
  validateSuite,
  validateSuiteMatrix,
  validateSuiteOwnership,
} from './prepare-codex-approved-tools.mjs'

test('original proxy image must satisfy the same policy used for restoration', () => {
  for (const image of [
    'clerum/codex-llm-proxy:test',
    `ghcr.io/evenfire-ai/codex-llm-proxy@sha256:${'a'.repeat(64)}`,
  ])
    assert.doesNotThrow(() => validateProxyImage(image, 'IfNotPresent'))
  for (const image of ['localhost:5000/proxy:test', 'unrelated/proxy:test', ''])
    assert.throws(() => validateProxyImage(image, 'Never'), /Invalid proxy image/)
  assert.throws(
    () => validateProxyImage('clerum/codex-llm-proxy:test', 'invalid'),
    /Invalid proxy image/
  )
})

const scenarios = makeScenarios(
  'approved-tools-a1b2c3d4e5f6',
  [43101, 43102, 43103],
  43104,
  'codex',
  undefined,
  'approved-tools'
)

test('explicit tools fixtures never enter default publish, acquisition or verification sets', () => {
  for (const name of [
    'codex-approved-tools-mcp-e2e',
    'codex-approved-tools-proxy-e2e',
    'codex-approved-tools-workflow-e2e',
  ]) {
    const image = IMAGES.find(image => image.name === name)
    assert.ok(image)
    assert.equal(
      publishedImages().some(image => image.name === name),
      false
    )
    assert.equal(
      pullInGhcrMode().some(image => image.name === name),
      false
    )
    for (const options of [
      { mode: 'local' },
      { mode: 'ghcr', tag: 'test' },
      { mode: 'ghcr', tag: 'test', includeE2eFixtures: true },
    ]) {
      assert.equal(minikubeVerifyRefs(options).includes(localRef(image)), false)
    }
  }
})

test('fourth workflow scenario has separate backend, explicit grant and two retained approval gates', () => {
  const workflow = makeWorkflowScenario('approved-tools-a1b2c3d4e5f6', 43105, 43104)
  for (const field of [
    'runId',
    'agentName',
    'contextName',
    'connectorName',
    'connectionKey',
    'fixtureUrl',
  ])
    assert.ok(scenarios.every(s => s[field] !== workflow[field]))
  assert.equal(workflow.catalogSize, 83)
  const host = makeResources([workflow]).find(r => r.kind === 'Host')
  assert.equal(host.spec.model.connectionRef, 'unassigned')
  assert.equal(host.spec.approval, undefined)
  assert.ok(host.spec.workflowControl.scopes.includes('workflow:trigger'))
  const [recipe, egress, ingress] = makeWorkflowResources(workflow)
  assert.deepEqual(recipe.spec.steps, [{ id: 'receipt', mcpServers: ['receipt'] }])
  assert.deepEqual(recipe.spec.triggers.onDemand, {
    requiresApproval: true,
    allowedActors: ['user'],
  })
  assert.deepEqual(recipe.spec.agent, { provider: 'codex-subscription', model: workflow.modelName })
  assert.equal(
    recipe.metadata.annotations['clerum.io/codex-connection-ref'],
    workflow.connectionKey
  )
  assert.equal(recipe.spec.coordinatorImage, 'clerum/workflow-custom-sdk-e2e:approved-tools-test')
  assert.deepEqual(recipe.spec.output, { destination: 'pvc', format: 'json' })
  assert.deepEqual(recipe.spec.mcpServers, [
    {
      id: 'receipt',
      endpoint: `http://${workflow.connectorName}.mcp-server.svc.cluster.local:8080/mcp`,
    },
  ])
  assert.deepEqual(egress.spec.podSelector, {
    matchLabels: {
      'clerum.io/workflow-output-scope': workflow.workflowName,
      'clerum.io/component': 'workflow-coordinator',
    },
  })
  assert.equal(egress.spec.egress.length, 1)
  assert.deepEqual(egress.spec.egress[0].to, [
    {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'mcp-server' } },
      podSelector: { matchLabels: { 'clerum.io/mcpserver': workflow.connectorName } },
    },
  ])
  assert.deepEqual(egress.spec.egress[0].ports, [{ protocol: 'TCP', port: 8080 }])
  assert.deepEqual(ingress.spec.podSelector, egress.spec.egress[0].to[0].podSelector)
  assert.deepEqual(ingress.spec.ingress[0].from, [
    {
      namespaceSelector: {
        matchLabels: { 'kubernetes.io/metadata.name': workflow.workflowNamespace },
      },
      podSelector: egress.spec.podSelector,
    },
  ])
  assert.deepEqual(ingress.spec.ingress[0].ports, [{ protocol: 'TCP', port: 8080 }])
})

test('all three isolated catalogs start without connector grants or subscription bindings', () => {
  assert.deepEqual(
    scenarios.map(s => s.catalogSize),
    [83, 150, 250]
  )
  assert.equal(new Set(scenarios.map(s => s.contextName)).size, 3)
  assert.equal(new Set(scenarios.map(s => s.fixtureUrl)).size, 3)
  const resources = makeResources(scenarios)
  assert.equal(resources.length, 9)
  for (const context of resources.filter(r => r.kind === 'Context'))
    assert.deepEqual(context.spec.mcpServers, [])
  for (const host of resources.filter(r => r.kind === 'Host')) {
    assert.equal(host.spec.model.connectionRef, 'unassigned')
    assert.equal(host.spec.model.provider, 'codex-subscription')
    assert.equal(host.spec.llmPolicy, undefined)
    assert.equal(host.spec.secretRef, undefined)
  }
  for (const mcp of resources.filter(r => r.kind === 'McpServer')) {
    const scenario = scenarios.find(s => s.connectorName === mcp.metadata.name)
    assert.equal(mcp.spec.image, 'clerum/codex-approved-tools-mcp-e2e:test')
    assert.equal(mcp.spec.imagePullPolicy, 'Never')
    assert.equal(mcp.spec.transport.port, 8080)
    assert.equal(mcp.spec.env.find(v => v.name === 'RUN_ID').value, scenario.runId)
    assert.equal(
      mcp.spec.env.find(v => v.name === 'CATALOG_SIZE').value,
      String(scenario.catalogSize)
    )
  }
})

test('rejects traversal identities, repeated or privileged fixture ports and a foreign suite', () => {
  const suite = 'approved-tools'
  assert.throws(() =>
    makeScenarios('../escape', [43101, 43102, 43103], 43104, 'codex', undefined, suite)
  )
  assert.throws(() =>
    makeScenarios(
      'approved-tools-a1b2c3d4e5f6',
      [43101, 43101, 43103],
      43104,
      'codex',
      undefined,
      suite
    )
  )
  assert.throws(() =>
    makeScenarios(
      'approved-tools-a1b2c3d4e5f6',
      [80, 43102, 43103],
      43104,
      'codex',
      undefined,
      suite
    )
  )
  assert.throws(() =>
    makeScenarios('approved-tools-a1b2c3d4e5f6', [43101], 43104, 'codex', undefined, suite)
  )
  assert.throws(
    () => makeScenarios('approved-tools-a1b2c3d4e5f6', [43101], 43104, 'codex'),
    /APPROVED_TOOLS_SUITE_UNSUPPORTED/
  )
  assert.throws(
    () => makeScenarios('approved-tools-a1b2c3d4e5f6', [43101], 43104, 'codex', undefined, 'other'),
    /APPROVED_TOOLS_SUITE_UNSUPPORTED/
  )
})

test('roundtrip rejects pruned display/model/empty grant fields while accepting server defaults', () => {
  const resources = makeResources(scenarios)
  const observed = structuredClone(resources)
  observed[0].metadata.uid = 'server-generated-id'
  assert.doesNotThrow(() => assertResourceRoundTrip(resources, observed))
  for (const [index, key] of [
    [0, 'mcpServers'],
    [1, 'host'],
    [1, 'model'],
  ]) {
    const pruned = structuredClone(observed)
    delete pruned[index].spec[key]
    assert.throws(() => assertResourceRoundTrip(resources, pruned))
  }
})

test('dry-run parser accepts a List document and a kubectl v1.36 object-per-item stream', () => {
  const resources = makeResources(scenarios)
  const observed = structuredClone(resources)
  observed.forEach((item, index) => {
    item.metadata.uid = `server-generated-${index}`
    // Braces and escaped quotes inside strings must not split an object.
    item.metadata.annotations = { note: 'a "}{" value \\ with braces' }
  })
  const list = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: observed }, null, 2)
  const stream = observed.map(item => JSON.stringify(item, null, 4)).join('\n') + '\n'
  for (const output of [list, stream]) {
    const items = parseDryRunItems(output)
    assert.equal(items.length, resources.length)
    assert.deepEqual(items, observed)
    assert.doesNotThrow(() => assertResourceRoundTrip(resources, items))
  }
  const pruned = structuredClone(observed)
  pruned.pop()
  const shortStream = pruned.map(item => JSON.stringify(item)).join('\n')
  assert.equal(parseDryRunItems(shortStream).length, resources.length - 1)
  assert.throws(
    () => assertResourceRoundTrip(resources, parseDryRunItems(shortStream)),
    /Fixture array was not preserved/
  )
})

test('dry-run parser rejects empty, truncated, non-object and mixed List output', () => {
  const item = JSON.stringify({ kind: 'Namespace', metadata: { name: 'a' } })
  const list = JSON.stringify({ kind: 'List', items: [] })
  for (const [output, message] of [
    ['', /empty/],
    [' \n', /empty/],
    [item.slice(0, -1), /ends inside a JSON object/],
    [`${item}\ntrailing`, /not a sequence of JSON objects/],
    [`[${item}]`, /not a sequence of JSON objects/],
    [`${item},${item}`, /not a sequence of JSON objects/],
    [`${list}\n${item}`, /mixes a List/],
    [JSON.stringify({ kind: 'List' }), /has no items/],
  ])
    assert.throws(() => parseDryRunItems(output), message)
  assert.deepEqual(parseDryRunItems(list), [])
})

test('evidence accepts only exact canonical run children and rejects symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-tools-setup-'))
  try {
    const runs = path.join(root, '.local-notes/infra/runs')
    const run = path.join(runs, 'one')
    fs.mkdirSync(run, { recursive: true })
    assert.equal(validateRunDirectory(root, run), fs.realpathSync(run))
    assert.throws(() => validateRunDirectory(root, runs))
    const link = path.join(runs, 'link')
    fs.symlinkSync(run, link)
    assert.throws(() => validateRunDirectory(root, link))
    fs.mkdirSync(path.join(run, 'nested'))
    assert.throws(() => validateRunDirectory(root, path.join(run, 'nested')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('missing seed and lease fail before first cluster mutation; no image acquisition in preparation', () => {
  const source = fs.readFileSync(
    new URL('./prepare-codex-approved-tools.mjs', import.meta.url),
    'utf8'
  )
  const mutation = source.indexOf("kubectl(['create'")
  const lease = source.indexOf("command('lease', [])")
  const seedRead = source.indexOf(
    'readOwnedFile(path.dirname(seedFile), path.basename(seedFile), 128 * 1024)'
  )
  assert.ok(lease >= 0 && lease < mutation)
  assert.ok(seedRead >= 0 && seedRead < mutation)
  const hybridPatch = source.indexOf(
    "if (required('APPROVED_TOOLS_UPSTREAM_MODE') === 'real-hybrid')"
  )
  assert.ok(lease < hybridPatch)
  const hybrid = source.slice(hybridPatch)
  const proof = hybrid.indexOf('buildApprovedToolsImageProof({')
  const proxyPatch = hybrid.search(
    /'patch',\s*`deployment\/\$\{proxy\.name\}`,\s*'--type=strategic'/
  )
  assert.ok(proof >= 0 && proxyPatch > proof)
  assert.equal(source.includes('build-images.sh'), false)
  assert.ok(source.includes("owner('pf_owner_record_process_matches'"))
  assert.ok(source.includes('state.originalImagePullPolicy'))
  assert.ok(source.includes('container.image !== state.originalProxyImage'))
})

test('real-hybrid proxy patch accepts only the five guarded test environment keys', () => {
  const profile = 'clerum-test-12345678'
  const env = [
    { name: 'NODE_ENV', value: 'test' },
    { name: 'CODEX_APPROVED_TOOLS_TEST_ONLY', value: '1' },
    { name: 'CODEX_APPROVED_TOOLS_MINIKUBE_PROFILE', value: profile },
    { name: 'APPROVED_TOOLS_UPSTREAM_MODE', value: 'real-hybrid' },
    { name: 'CODEX_REAL_UPSTREAM_CONFIRM', value: '1' },
  ]
  const patch = {
    metadata: { uid: 'owned', resourceVersion: '1' },
    spec: {
      template: {
        metadata: {
          annotations: { 'evenfire.ai/codex-tools-fixture-run': 'approved-tools-123456789abc' },
        },
        spec: {
          containers: [
            {
              name: 'codex-llm-proxy',
              image: 'clerum/codex-approved-tools-proxy-e2e:test',
              imagePullPolicy: 'Never',
              env,
            },
          ],
        },
      },
    },
  }
  const args = value => [
    `--context=${profile}`,
    '--request-timeout=30s',
    '-n',
    'control-plane',
    'patch',
    'deployment/codex-llm-proxy',
    '--type=strategic',
    '-p',
    JSON.stringify(value),
  ]
  assert.doesNotThrow(() => validateKubectlArgs(args(patch), profile))
  for (const [name, value] of [
    ['CODEX_REAL_UPSTREAM_CONFIRM', '0'],
    ['APPROVED_TOOLS_UPSTREAM_MODE', 'real'],
  ]) {
    const changed = structuredClone(patch)
    changed.spec.template.spec.containers[0].env.find(entry => entry.name === name).value = value
    assert.throws(() => validateKubectlArgs(args(changed), profile), /Invalid proxy environment/)
  }
})

test('owned descriptors reject links, nonregular files, oversized data and unsafe directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-fixture-file-'))
  try {
    fs.writeFileSync(path.join(root, 'data.json'), 'valid', { mode: 0o600 })
    fs.symlinkSync('data.json', path.join(root, 'link.json'))
    assert.throws(() => readOwnedFile(root, 'link.json', 100))
    assert.throws(() => readOwnedFile(root, 'data.json', 4))
    assert.throws(() => readOwnedFile(root, '../outside', 100))
    fs.mkdirSync(path.join(root, 'directory'))
    assert.throws(() => readOwnedFile(root, 'directory', 100))
    fs.linkSync(path.join(root, 'data.json'), path.join(root, 'hardlink'))
    assert.throws(() => readOwnedFile(root, 'hardlink', 100))
    fs.unlinkSync(path.join(root, 'hardlink'))
    fs.chmodSync(root, 0o777)
    assert.throws(() => readOwnedFile(root, 'data.json', 100))
    fs.chmodSync(root, 0o700)
    assert.equal(readOwnedFile(root, 'data.json', 100), 'valid')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('path replacement after opening cannot redirect reads or state writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-fixture-race-'))
  const file = openOwnedFile(root, 'state.json', { create: true, maxBytes: 100 })
  try {
    fs.writeSync(file.fd, 'original')
    fs.renameSync(path.join(root, 'state.json'), path.join(root, 'retained.json'))
    fs.writeFileSync(path.join(root, 'unrelated'), 'untouched', { mode: 0o600 })
    fs.symlinkSync('unrelated', path.join(root, 'state.json'))
    assert.equal(readOwnedDescriptor(file), 'original')
    fs.writeSync(file.fd, Buffer.from('updated!'), 0, 8, 0)
    assert.equal(fs.readFileSync(path.join(root, 'unrelated'), 'utf8'), 'untouched')
    assert.throws(() => openOwnedFile(root, 'state.json', { create: true }))
    fs.unlinkSync(path.join(root, 'retained.json'))
    assert.throws(() => readOwnedDescriptor(file))
  } finally {
    fs.closeSync(file.fd)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects hostile profile, kubectl operation and owner arguments before subprocesses', () => {
  const profile = 'clerum-fix-tools-1234abcd'
  for (const value of [
    'clerum-dev',
    'clerum-$(echo bad)-1234abcd',
    'clerum-a;echo-b-1234abcd',
    '--context=other',
    '../clerum-a-1234abcd',
  ])
    assert.throws(() => validateProfile(value))
  const prefix = [`--context=${profile}`, '--request-timeout=30s']
  assert.doesNotThrow(() =>
    validateKubectlArgs(
      [...prefix, '-n', 'control-plane', 'get', 'deployment/codex-llm-proxy', '-o', 'json'],
      profile
    )
  )
  for (const suffix of [
    ['delete', 'namespace/default'],
    ['-n', 'default', 'get', 'secret/all'],
    ['-n', 'control-plane', 'exec', 'deployment/control-api', '--', 'sh', '-c', 'anything'],
  ])
    assert.throws(() => validateKubectlArgs([...prefix, ...suffix], profile))
  const worktree = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  const pidDirectory = '/tmp/owned-profile/pids'
  const record = `${pidDirectory}/approved-tools-a1b2c3d4e5f6-codex-llm-proxy.pid`
  const args = [
    record,
    profile,
    profile,
    worktree,
    'control-plane',
    'codex-llm-proxy',
    '43101',
    '9090',
  ]
  assert.doesNotThrow(() => validateOwnerArgs(args, false, profile, pidDirectory))
  for (const [index, value] of [
    [0, '/tmp/unrelated.pid'],
    [2, 'other-context'],
    [5, '--anything'],
    [6, '80'],
    [7, '8090'],
  ]) {
    const invalid = [...args]
    invalid[index] = value
    assert.throws(() => validateOwnerArgs(invalid, false, profile, pidDirectory))
  }
  assert.throws(() =>
    validateOwnerArgs([record, '1;echo', ...args.slice(1)], true, profile, pidDirectory)
  )
})

test('fixed ownership CLI rejects invalid operations and bindings without touching unrelated files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-tools-owner-cli-'))
  const profile = 'clerum-fixture-owner-1234abcd'
  const worktree = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  const pidDirectory = path.join(root, profile, 'pids')
  fs.mkdirSync(pidDirectory, { recursive: true })
  const canonicalPidDirectory = fs.realpathSync(pidDirectory)
  const record = path.join(canonicalPidDirectory, 'approved-tools-a1b2c3d4e5f6-codex-llm-proxy.pid')
  const sentinel = path.join(root, 'unrelated')
  fs.writeFileSync(sentinel, 'untouched')
  const args = [
    record,
    profile,
    profile,
    worktree,
    'control-plane',
    'codex-llm-proxy',
    '43101',
    '9090',
  ]
  const env = {
    PATH: process.env.PATH,
    MINIKUBE_PROFILE: profile,
    CONTROL_API_REAL_PG_CONTEXT: profile,
    T2_PROFILE_ROOT: root,
  }
  const run = (operation, values = args) =>
    spawnSync('bash', ['scripts/e2e/codex-approved-tools-pf-owner.sh', operation, ...values], {
      cwd: worktree,
      env,
      encoding: 'utf8',
      timeout: 5000,
    })
  try {
    // The canonical library's valid missing-record cleanup is a harmless no-op.
    assert.equal(run('cleanup').status, 0)
    const workflowService = 'approved-tools-a1b2c3d4e5f6-mcp-workflow'
    const workflowRecord = path.join(
      canonicalPidDirectory,
      `approved-tools-a1b2c3d4e5f6-${workflowService}.pid`
    )
    const workflowArgs = [
      workflowRecord,
      profile,
      profile,
      worktree,
      'mcp-server',
      workflowService,
      '43105',
      '8080',
    ]
    assert.equal(run('cleanup', workflowArgs).status, 0)
    const invalidWorkflow = [...workflowArgs]
    invalidWorkflow[5] += '-other'
    assert.equal(run('cleanup', invalidWorkflow).status, 2)
    for (const operation of ['unknown', 'cleanup;echo', '--help', 'pf_owner_cleanup_record'])
      assert.equal(run(operation).status, 2)
    for (const [index, value] of [
      [0, sentinel],
      [1, 'clerum-dev'],
      [2, 'other-context'],
      [3, root],
      [4, 'default'],
      [5, '--service'],
      [6, '80'],
      [7, '8080'],
    ]) {
      const invalid = [...args]
      invalid[index] = value
      assert.equal(run('cleanup', invalid).status, 2)
    }
    assert.equal(run('record', [record, 'bad-pid', ...args.slice(1)]).status, 2)
    assert.equal(run('cleanup', args.slice(1)).status, 2)
    const mismatch = [...args]
    mismatch[0] = path.join(
      canonicalPidDirectory,
      'approved-tools-a1b2c3d4e5f6-approved-tools-a1b2c3d4e5f6-mcp-83.pid'
    )
    assert.equal(run('cleanup', mismatch).status, 2)
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched')
    assert.deepEqual(fs.readdirSync(pidDirectory), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// Addendum 20 contracts: these tests run before the provider/config changes.
test('Grok prepares exactly one unbound 83-tool agent and rejects other provider presets', () => {
  const rows = makeScenarios(
    'approved-tools-a1b2c3d4e5f6',
    [43101],
    43104,
    'grok',
    'Manual Grok',
    'model-step-retry'
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].catalogSize, 83)
  assert.equal(rows[0].modelName, 'grok-4.6')
  assert.equal(rows[0].subscriptionName, 'Manual Grok')
  const resources = makeResources(rows)
  assert.equal(resources.length, 3)
  assert.deepEqual(resources.find(row => row.kind === 'Host').spec.model, {
    provider: 'grok-subscription',
    name: 'grok-4.6',
    connectionRef: 'unassigned',
  })
  assert.deepEqual(resources.find(row => row.kind === 'Context').spec.mcpServers, [])
  assert.throws(
    () =>
      makeScenarios(
        'approved-tools-a1b2c3d4e5f6',
        [43101],
        43104,
        'other',
        undefined,
        'approved-tools'
      ),
    /provider/
  )
  assert.throws(
    () =>
      makeScenarios('approved-tools-a1b2c3d4e5f6', [43101], 43104, 'grok', '', 'model-step-retry'),
    /GROK_CONNECTION_REQUIRED/
  )
  // Grok is only allowed with the model-step-retry suite and deterministic upstream.
  assert.throws(
    () =>
      makeScenarios(
        'approved-tools-a1b2c3d4e5f6',
        [43101],
        43104,
        'grok',
        'Manual Grok',
        'approved-tools'
      ),
    /APPROVED_TOOLS_SUITE_UNSUPPORTED/
  )
})

test('Host ConfigMap merge patch admits only presentation, UID, resourceVersion and run annotation', () => {
  const profile = 'clerum-fix-tools-1234abcd'
  const prefix = [`--context=${profile}`, '--request-timeout=30s']
  const patch = {
    metadata: {
      uid: 'owned-config',
      resourceVersion: '12',
      annotations: { 'evenfire.ai/codex-tools-fixture-run': 'approved-tools-a1b2c3d4e5f6' },
    },
    data: { CODEX_TOOL_PRESENTATION: 'auto' },
  }
  const args = body => [
    ...prefix,
    '-n',
    'mcp-host',
    'patch',
    'configmap/mcp-host-config',
    '--type=merge',
    '-p',
    JSON.stringify(body),
  ]
  assert.doesNotThrow(() => validateKubectlArgs(args(patch), profile))
  const restored = structuredClone(patch)
  restored.metadata.annotations['evenfire.ai/codex-tools-fixture-run'] = null
  restored.data.CODEX_TOOL_PRESENTATION = null
  assert.doesNotThrow(() => validateKubectlArgs(args(restored), profile))
  for (const mutate of [
    body => {
      body.data.CLERUM_MODEL_STEP_AUTO_RETRIES = '1'
    },
    body => {
      body.data.CODEX_TOOL_PRESENTATION = 'invalid'
    },
    body => {
      delete body.metadata.resourceVersion
    },
    body => {
      body.metadata.annotations.extra = 'unowned'
    },
    body => {
      body.spec = {}
    },
  ]) {
    const invalid = structuredClone(patch)
    mutate(invalid)
    assert.throws(() => validateKubectlArgs(args(invalid), profile), /Host ConfigMap/)
  }
  assert.throws(() =>
    validateKubectlArgs(
      args(patch).map(v => (v === '--type=merge' ? '--type=strategic' : v)),
      profile
    )
  )
})

test('Grok kubectl and forward admission stays bound to its exact proxy and probe selector', () => {
  const profile = 'clerum-fix-tools-1234abcd'
  const prefix = [`--context=${profile}`, '--request-timeout=30s']
  for (const suffix of [
    ['-n', 'control-plane', 'get', 'deployment/grok-llm-proxy', '-o', 'json'],
    ['-n', 'control-plane', 'get', 'service/grok-llm-proxy', '-o', 'json'],
    ['-n', 'control-plane', 'get', 'pods', '-l', 'app=grok-llm-proxy', '-o', 'json'],
    ['-n', 'control-plane', 'rollout', 'status', 'deployment/grok-llm-proxy', '--timeout=180s'],
  ])
    assert.doesNotThrow(() => validateKubectlArgs([...prefix, ...suffix], profile))
  for (const selector of ['app=other', 'app=grok-llm-proxy,extra=true'])
    assert.throws(() =>
      validateKubectlArgs(
        [...prefix, '-n', 'control-plane', 'get', 'pods', '-l', selector, '-o', 'json'],
        profile
      )
    )
  assert.doesNotThrow(() =>
    validateProxyImage('clerum/grok-llm-proxy:test', 'IfNotPresent', 'grok')
  )
  assert.throws(() => validateProxyImage('clerum/codex-llm-proxy:test', 'Never', 'grok'))
  const worktree = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  const directory = '/tmp/owned-profile/pids'
  const args = [
    `${directory}/approved-tools-a1b2c3d4e5f6-grok-llm-proxy.pid`,
    profile,
    profile,
    worktree,
    'control-plane',
    'grok-llm-proxy',
    '43101',
    '9090',
  ]
  assert.doesNotThrow(() => validateOwnerArgs(args, false, profile, directory))
  assert.throws(() =>
    validateOwnerArgs(
      [...args.slice(0, 5), 'codex-llm-proxy', ...args.slice(6)],
      false,
      profile,
      directory
    )
  )
})

test('Grok forward ownership CLI admits its exact probe service without touching other records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-owner-cli-'))
  const profile = 'clerum-fixture-owner-1234abcd'
  const worktree = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  try {
    const pids = path.join(root, profile, 'pids')
    fs.mkdirSync(pids, { recursive: true })
    const record = path.join(
      fs.realpathSync(pids),
      'approved-tools-a1b2c3d4e5f6-grok-llm-proxy.pid'
    )
    const args = [
      record,
      profile,
      profile,
      worktree,
      'control-plane',
      'grok-llm-proxy',
      '43101',
      '9090',
    ]
    const run = values =>
      spawnSync('bash', ['scripts/e2e/codex-approved-tools-pf-owner.sh', 'cleanup', ...values], {
        cwd: worktree,
        env: {
          PATH: process.env.PATH,
          MINIKUBE_PROFILE: profile,
          CONTROL_API_REAL_PG_CONTEXT: profile,
          T2_PROFILE_ROOT: root,
        },
        encoding: 'utf8',
        timeout: 5000,
      })
    assert.equal(run(args).status, 0)
    assert.equal(run([...args.slice(0, 7), '8080']).status, 2)
    assert.deepEqual(fs.readdirSync(pids), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Grok scenario helper accepts one prepared agent without weakening Codex isolation', async () => {
  const { scenarios: read } =
    await import('../../tests/e2e/playwright/helpers/approved-tools-scenarios.ts')
  const previous = { ...process.env }
  try {
    const row = {
      ...scenarios[0],
      provider: 'grok',
      modelName: 'grok-4.6',
      subscriptionName: 'Manual Grok',
    }
    process.env.APPROVED_TOOLS_UPSTREAM_MODE = 'deterministic'
    process.env.APPROVED_TOOLS_PROVIDER = 'grok'
    process.env.APPROVED_TOOLS_SUITE = 'model-step-retry'
    process.env.APPROVED_TOOLS_GROK_CONNECTION_NAME = 'Manual Grok'
    process.env.APPROVED_TOOLS_SCENARIOS = JSON.stringify([row])
    assert.equal(read().length, 1)
    process.env.APPROVED_TOOLS_SCENARIOS = JSON.stringify([row, row])
    assert.throws(read, /one.*Grok/i)
    process.env.APPROVED_TOOLS_PROVIDER = 'codex'
    process.env.APPROVED_TOOLS_SUITE = 'approved-tools'
    process.env.APPROVED_TOOLS_SCENARIOS = JSON.stringify(scenarios.slice(0, 1))
    assert.throws(read, /three/)
    process.env.APPROVED_TOOLS_SCENARIOS = JSON.stringify(scenarios)
    assert.equal(read().length, 3)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
})

test('the suite matrix admits only the three supported lanes and has no default', () => {
  assert.deepEqual([...APPROVED_TOOLS_SUITES], ['approved-tools', 'model-step-retry'])
  for (const mode of ['deterministic', 'real', 'real-hybrid'])
    assert.equal(validateSuiteMatrix('codex', 'approved-tools', mode), 'approved-tools')
  assert.equal(
    validateSuiteMatrix('codex', 'model-step-retry', 'deterministic'),
    'model-step-retry'
  )
  assert.equal(validateSuiteMatrix('grok', 'model-step-retry', 'deterministic'), 'model-step-retry')
  for (const [provider, suite, mode] of [
    ['codex', 'model-step-retry', 'real'],
    ['codex', 'model-step-retry', 'real-hybrid'],
    ['grok', 'approved-tools', 'deterministic'],
    ['grok', 'model-step-retry', 'real'],
    ['codex', 'other', 'deterministic'],
    ['other', 'approved-tools', 'deterministic'],
    ['codex', 'approved-tools', 'other'],
  ])
    assert.throws(
      () => validateSuiteMatrix(provider, suite, mode),
      /APPROVED_TOOLS_SUITE_UNSUPPORTED|Invalid approved-tools provider/
    )
  assert.equal(validateSuite('approved-tools'), 'approved-tools')
  assert.throws(() => validateSuite(undefined), /APPROVED_TOOLS_SUITE_UNSUPPORTED/)
  assert.throws(() => validateSuite(''), /APPROVED_TOOLS_SUITE_UNSUPPORTED/)
})

test('model-step-retry prepares exactly one Codex 83 row without a provider or workflow', () => {
  const rows = makeScenarios(
    'approved-tools-a1b2c3d4e5f6',
    [43101],
    43102,
    'codex',
    undefined,
    'model-step-retry'
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].catalogSize, 83)
  assert.equal('provider' in rows[0], false)
  assert.equal(rows[0].agentName, 'approved-tools-a1b2c3d4e5f6-agent-83')
  assert.equal(rows[0].connectionKey, 'approved-tools-a1b2c3d4e5f6-grant-83')
  const resources = makeResources(rows)
  assert.equal(resources.length, 3)
  assert.deepEqual(resources.find(row => row.kind === 'Host').spec.model, {
    provider: 'codex-subscription',
    name: 'gpt-5.3-codex',
    connectionRef: 'unassigned',
  })
  assert.throws(() =>
    makeScenarios(
      'approved-tools-a1b2c3d4e5f6',
      [43101, 43102],
      43103,
      'codex',
      undefined,
      'model-step-retry'
    )
  )
})

test('restore binds the env suite to recorded state and admits the legacy approved-tools shape', () => {
  const run = 'approved-tools-a0b0f61a2f71'
  const legacy = {
    provider: 'codex',
    scenarios: [83, 150, 250].map(catalogSize => ({ catalogSize })),
    workflowScenario: { catalogSize: 83 },
    identityJournal: { grants: { agents: [], contexts: [], workflow: { name: `${run}-recipe` } } },
  }
  assert.equal(validateSuiteOwnership(legacy, 'approved-tools'), 'approved-tools')
  assert.throws(
    () => validateSuiteOwnership(legacy, 'model-step-retry'),
    /LEGACY_STATE_SUITE_UNSUPPORTED/
  )
  assert.equal(
    validateSuiteOwnership({ ...legacy, provider: undefined }, 'approved-tools'),
    'approved-tools'
  )
  for (const [label, state] of [
    ['single scenario', { ...legacy, scenarios: [{ catalogSize: 83 }] }],
    [
      'wrong sizes',
      { ...legacy, scenarios: [{ catalogSize: 83 }, { catalogSize: 83 }, { catalogSize: 250 }] },
    ],
    ['no workflow', { ...legacy, workflowScenario: undefined }],
    ['no grant', { ...legacy, identityJournal: { grants: { agents: [], contexts: [] } } }],
    ['grok provider', { ...legacy, provider: 'grok' }],
  ])
    assert.throws(
      () => validateSuiteOwnership(state, 'approved-tools'),
      /LEGACY_STATE_/,
      `${label} must be refused`
    )
  assert.equal(
    validateSuiteOwnership(
      {
        ...legacy,
        suite: 'model-step-retry',
        scenarios: [{ catalogSize: 83 }],
        workflowScenario: undefined,
      },
      'model-step-retry'
    ),
    'model-step-retry'
  )
  assert.throws(
    () => validateSuiteOwnership({ ...legacy, suite: 'approved-tools' }, 'model-step-retry'),
    /FIXTURE_SUITE_MISMATCH/
  )
})

test('a failed identity operation reports only a closed coded line', () => {
  const valid = { code: 'db_error', phase: 'delete-users', sqlstate: '23503' }
  assert.deepEqual(
    parseIdentityFailure(`startup noise\n${JSON.stringify({ e2eIdentityError: valid })}\n`),
    valid
  )
  assert.equal(identityFailureMessage(valid), 'IDENTITY_delete-users_db_error_23503')
  assert.equal(isIdentityFailureMessage(identityFailureMessage(valid)), true)
  assert.equal(
    identityFailureMessage({ code: 'step_failed', phase: 'commit', sqlstate: 'UNKNOWN' }),
    'IDENTITY_commit_step_failed'
  )
  assert.equal(
    isIdentityFailureMessage(
      identityFailureMessage({
        code: 'journal_grant_mismatch',
        phase: 'validate-intent',
        sqlstate: 'UNKNOWN',
      })
    ),
    true
  )
  const sentinel = 'raw runtime text e2e_never_echo'
  for (const output of [
    '',
    sentinel,
    JSON.stringify({ e2eIdentityError: { ...valid, message: sentinel } }),
    JSON.stringify({ e2eIdentityError: { ...valid, code: 'not_a_code' } }),
    JSON.stringify({ e2eIdentityError: { ...valid, phase: 'not-a-phase' } }),
    JSON.stringify({ e2eIdentityError: { ...valid, sqlstate: 'lowercase' } }),
    JSON.stringify({ e2eIdentityError: { code: 'unclassified' } }),
    JSON.stringify({ e2eIdentityError: valid }) + '\n' + 'x'.repeat(256 * 1024),
  ]) {
    const failure = parseIdentityFailure(output)
    assert.deepEqual(failure, { code: 'unparseable', phase: 'unknown', sqlstate: 'UNKNOWN' })
    assert.equal(JSON.stringify(failure).includes(sentinel), false)
    assert.equal(identityFailureMessage(failure).includes(sentinel), false)
  }
  for (const message of [
    'IDENTITY_',
    'IDENTITY_delete-users',
    'IDENTITY_delete-users_db_error_2350',
    'IDENTITY_not-a-phase_db_error',
    'IDENTITY_delete-users_not_a_code',
    'approved identity failure',
  ])
    assert.equal(isIdentityFailureMessage(message), false)
  assert.equal(isIdentityFailureMessage('IDENTITY_unknown_unparseable'), true)
})

test('Grok running-image witness requires ready owned pods, resourceVersion and the acquired image ID', async () => {
  const { observeGrokProxyPods } = await import('./prepare-codex-approved-tools.mjs')
  const id = `sha256:${'a'.repeat(64)}`
  const state = { imageProof: { images: { 'clerum/grok-approved-tools-proxy-e2e:test': id } } }
  const live = {
    items: [
      {
        metadata: {
          uid: 'owned-pod',
          resourceVersion: '42',
          namespace: 'control-plane',
          labels: { app: 'grok-llm-proxy' },
        },
        spec: {
          containers: [
            { name: 'grok-llm-proxy', image: 'clerum/grok-approved-tools-proxy-e2e:test' },
          ],
        },
        status: {
          phase: 'Running',
          containerStatuses: [{ name: 'grok-llm-proxy', ready: true, imageID: `docker://${id}` }],
        },
      },
    ],
  }
  assert.deepEqual(observeGrokProxyPods(live, state), [
    { uid: 'owned-pod', resourceVersion: '42', imageID: id },
  ])
  for (const mutate of [
    value => {
      value.items = []
    },
    value => {
      value.items[0].status.containerStatuses[0].imageID = `docker://sha256:${'b'.repeat(64)}`
    },
    value => {
      value.items[0].status.containerStatuses[0].ready = false
    },
    value => {
      delete value.items[0].metadata.resourceVersion
    },
    value => {
      value.items[0].metadata.labels.app = 'other-proxy'
    },
  ]) {
    const invalid = structuredClone(live)
    mutate(invalid)
    assert.throws(() => observeGrokProxyPods(invalid, state), /Grok proxy pod/)
  }
})
