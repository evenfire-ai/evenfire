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
  assert.ok(
    source.indexOf("command('bash', ['scripts/minikube/require-t2-mutation-lock.sh'])") < mutation
  )
  assert.ok(source.indexOf("fs.readFileSync(seedFile, 'utf8')") < mutation)
  assert.equal(source.includes('build-images.sh'), false)
  assert.ok(source.includes("owner('pf_owner_record_process_matches'"))
  assert.ok(source.includes('state.originalImagePullPolicy'))
  assert.ok(source.includes('container.image !== state.originalProxyImage'))
})
