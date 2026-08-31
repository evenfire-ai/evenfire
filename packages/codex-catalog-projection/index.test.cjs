'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const projection = require('./index.cjs')

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/allowlist-views.json'), 'utf8')
)

function withConnections(view, rewrite) {
  const parsed = JSON.parse(
    typeof view.metadata.annotations['clerum.io/codex-connections'] === 'string'
      ? view.metadata.annotations['clerum.io/codex-connections']
      : JSON.stringify(view.metadata.annotations['clerum.io/codex-connections'])
  )
  rewrite(parsed)
  return {
    metadata: {
      annotations: {
        ...view.metadata.annotations,
        'clerum.io/codex-connections': JSON.stringify(parsed),
      },
    },
    data: view.data,
  }
}

function mappedView() {
  return withConnections(FIXTURE.mapped, () => {})
}

test('runtime exports stay aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = Array.from(
    declarations.matchAll(/export declare (?:const|function)\s+([A-Za-z0-9_]+)/g),
    m => m[1]
  ).sort()
  assert.deepEqual(Object.keys(projection).sort(), declared)
})

test('assignedCodexConnectionKey treats empty as unassigned and never invents deployment-default', () => {
  assert.equal(projection.assignedCodexConnectionKey(undefined), 'unassigned')
  assert.equal(projection.assignedCodexConnectionKey(''), 'unassigned')
  assert.equal(projection.assignedCodexConnectionKey('   '), 'unassigned')
  assert.equal(projection.assignedCodexConnectionKey('team-plus'), 'team-plus')
  assert.equal(projection.assignedCodexConnectionKey('deployment-default'), 'deployment-default')
  assert.equal(projection.isCodexUnassignedConnectionKey(''), true)
})

test('unassigned never inherits a mapped or legacy catalog', () => {
  const mapped = projection.parseAllowedModelsSnapshot(mappedView(), 'unassigned')
  assert.equal(mapped.connectionStatus, 'disconnected')
  assert.ok(!Array.from(mapped.enabledModels).includes('codex-subscription:gpt-5.3-codex'))
  assert.ok(Array.from(mapped.enabledModels).includes('openai:gpt-4'))
  assert.equal(projection.toPolicyBinding(mappedView(), 'unassigned'), null)

  const legacy = projection.parseAllowedModelsSnapshot(FIXTURE.legacy, 'unassigned')
  assert.equal(legacy.connectionStatus, 'disconnected')
  assert.ok(!Array.from(legacy.enabledModels).includes('codex-subscription:gpt-5.3-codex'))
  assert.equal(projection.toPolicyBinding(FIXTURE.legacy, ''), null)

  const spend = projection.snapshotForAssignedCodexGrant('unassigned', mappedView(), {
    flagEnabled: true,
  })
  assert.equal(spend.connectionStatus, 'disconnected')
  assert.deepEqual([...spend.enabledModels], [])
})

test('legacy without a map keeps the flat catalog for a real key', () => {
  for (const key of ['team-plus', 'deployment-default']) {
    const snapshot = projection.parseAllowedModelsSnapshot(FIXTURE.legacy, key)
    assert.ok(Array.from(snapshot.enabledModels).includes('codex-subscription:gpt-5.3-codex'))
    const binding = projection.toPolicyBinding(FIXTURE.legacy, key)
    assert.deepEqual(binding, {
      catalogRevision: 4,
      credentialRevision: 2,
      connectionKey: key,
    })
    assert.equal(binding.models, undefined)
  }
})

test('mapped miss and omitted models[] empty Codex without rematch', () => {
  const miss = projection.parseAllowedModelsSnapshot(mappedView(), 'ghost-grant')
  assert.equal(miss.connectionStatus, 'disconnected')
  assert.ok(!Array.from(miss.enabledModels).includes('codex-subscription:gpt-5.1'))
  assert.equal(projection.toPolicyBinding(mappedView(), 'ghost-grant'), null)

  const omitted = withConnections(FIXTURE.mapped, parsed => {
    delete parsed['personal-pro'].models
  })
  const snapshot = projection.parseAllowedModelsSnapshot(omitted, 'personal-pro')
  assert.equal(snapshot.connectionStatus, 'disconnected')
  assert.ok(!Array.from(snapshot.enabledModels).includes('codex-subscription:gpt-5.1'))
  assert.equal(projection.toPolicyBinding(omitted, 'personal-pro'), null)
})

test('revoked is a first-class connectionStatus and blocks execute', () => {
  const revoked = projection.parseAllowedModelsSnapshot(mappedView(), 'team-plus')
  assert.equal(revoked.connectionStatus, 'revoked')
  assert.equal(revoked.connectionRevision, 8)
  const projectionResult = projection.projectCodexExecution(
    { model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' } },
    revoked
  )
  assert.equal(projectionResult.eligibility, 'ineligible')
  assert.equal(projectionResult.reason, 'connection_revoked')
})

test('mapped hit intersects models and does not rematch another grant', () => {
  const snapshot = projection.parseAllowedModelsSnapshot(mappedView(), 'personal-pro')
  assert.equal(snapshot.connectionStatus, 'connected')
  assert.deepEqual(Array.from(snapshot.enabledModels).filter(k => k.startsWith('codex-subscription:')), [
    'codex-subscription:gpt-5.1',
  ])
  const otherModel = projection.projectCodexExecution(
    { model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' } },
    snapshot
  )
  assert.equal(otherModel.eligibility, 'ineligible')
  assert.deepEqual(projection.toPolicyBinding(mappedView(), 'personal-pro'), {
    catalogRevision: 4,
    credentialRevision: 2,
    connectionKey: 'personal-pro',
    models: ['gpt-5.1'],
  })
})

test('driftHashInput excludes catalog and connection revisions', () => {
  const spec = { model: { provider: 'codex-subscription', name: 'gpt-5.1' } }
  const baseline = projection.projectCodexExecution(spec, {
    flagEnabled: true,
    connectionStatus: 'connected',
    catalogRevision: 1,
    connectionRevision: 1,
    enabledModels: ['codex-subscription:gpt-5.1'],
    staleModels: [],
  })
  const bumped = projection.projectCodexExecution(spec, {
    flagEnabled: true,
    connectionStatus: 'connected',
    catalogRevision: 99,
    connectionRevision: 12,
    catalogContentHash: 'other',
    enabledModels: ['codex-subscription:gpt-5.1'],
    staleModels: [],
  })
  assert.equal(baseline.driftHashInput, bumped.driftHashInput)
  assert.ok(!baseline.driftHashInput.includes('99'))
  assert.ok(!baseline.driftHashInput.includes('catalogRevision'))
})

test('missing ConfigMap is an error snapshot and a null binding', () => {
  const snapshot = projection.parseAllowedModelsSnapshot(undefined, 'team-plus')
  assert.equal(snapshot.snapshotError, 'missing')
  assert.equal(projection.toPolicyBinding(undefined, 'team-plus'), null)
})
