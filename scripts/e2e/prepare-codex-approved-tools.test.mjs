import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  IMAGES,
  minikubeVerifyRefs,
  publishedImages,
  pullInGhcrMode,
} from '../release/images-manifest.mjs'
import {
  assertResourceRoundTrip,
  makeResources,
  makeScenarios,
  openOwnedFile,
  readOwnedDescriptor,
  readOwnedFile,
  validateKubectlArgs,
  validateOwnerArgs,
  validateProfile,
  validateRunDirectory,
} from './prepare-codex-approved-tools.mjs'

const scenarios = makeScenarios('approved-tools-a1b2c3d4e5f6', [43101, 43102, 43103], 43104)

test('explicit tools fixtures never enter default publish, acquisition or verification sets', () => {
  for (const name of ['codex-approved-tools-mcp-e2e', 'codex-approved-tools-proxy-e2e']) {
    assert.ok(IMAGES.some(image => image.name === name))
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
      assert.equal(
        minikubeVerifyRefs(options).some(ref => ref.includes(name)),
        false
      )
    }
  }
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

test('rejects traversal identities, repeated or privileged fixture ports', () => {
  assert.throws(() => makeScenarios('../escape', [43101, 43102, 43103], 43104))
  assert.throws(() => makeScenarios('approved-tools-a1b2c3d4e5f6', [43101, 43101, 43103], 43104))
  assert.throws(() => makeScenarios('approved-tools-a1b2c3d4e5f6', [80, 43102, 43103], 43104))
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
  const seedRead = source.indexOf('const seedSource = readOwnedFile(')
  assert.ok(lease >= 0 && lease < mutation)
  assert.ok(seedRead >= 0 && seedRead < mutation)
  assert.equal(source.includes('build-images.sh'), false)
  assert.ok(source.includes("owner('pf_owner_record_process_matches'"))
  assert.ok(source.includes('state.originalImagePullPolicy'))
  assert.ok(source.includes('container.image !== state.originalProxyImage'))
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
