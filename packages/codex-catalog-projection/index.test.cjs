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
  assert.deepEqual(
    Array.from(snapshot.enabledModels).filter(k => k.startsWith('codex-subscription:')),
    ['codex-subscription:gpt-5.1']
  )
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

// ── toEligiblePolicyBinding: the execution gate ───────────────────────────

function withAnnotations(view, annotations) {
  return {
    metadata: {
      annotations: {
        ...view.metadata.annotations,
        ...annotations,
        ...(typeof view.metadata.annotations['clerum.io/codex-connections'] === 'object' &&
        view.metadata.annotations['clerum.io/codex-connections'] !== null
          ? {
              'clerum.io/codex-connections': JSON.stringify(
                view.metadata.annotations['clerum.io/codex-connections']
              ),
            }
          : {}),
      },
    },
    data: view.data,
  }
}

/**
 * Every case below is also fed to the parity oracle at the bottom of the file.
 * `{ cm, key, model }` plus the expected `binding !== null` and `reason`.
 */
const ELIGIBILITY_MATRIX = [
  {
    name: 'mapped hit: connected, listed in the map and in the catalog',
    cm: () => mappedView(),
    key: 'personal-pro',
    model: 'gpt-5.1',
    binding: {
      connectionKey: 'personal-pro',
      catalogRevision: 4,
      credentialRevision: 2,
      model: 'gpt-5.1',
    },
    reason: 'eligible',
  },
  ...['disconnected', 'reauth-required', 'unavailable', 'revoked'].map(status => ({
    name: `mapped connection status ${status} withholds the binding`,
    cm: () =>
      withConnections(FIXTURE.mapped, parsed => {
        parsed['personal-pro'].status = status
      }),
    key: 'personal-pro',
    model: 'gpt-5.1',
    binding: null,
    reason: `connection_${status}`,
  })),
  {
    name: 'Codex feature flag off withholds the binding',
    cm: () => withAnnotations(FIXTURE.mapped, { 'clerum.io/codex-enabled': 'false' }),
    key: 'personal-pro',
    model: 'gpt-5.1',
    binding: null,
    reason: 'flag_off',
  },
  {
    name: 'a stale catalog row withholds the binding',
    cm: () => ({
      metadata: mappedView().metadata,
      data: {
        ...FIXTURE.mapped.data,
        'codex-subscription': JSON.stringify([
          { model: 'gpt-5.3-codex', stale: false },
          { model: 'gpt-5.1', stale: true },
        ]),
      },
    }),
    key: 'personal-pro',
    model: 'gpt-5.1',
    binding: null,
    reason: 'no_eligible_broker_target',
  },
  {
    name: 'a model listed in the grant map but absent from the catalog withholds the binding',
    cm: () =>
      withConnections(FIXTURE.mapped, parsed => {
        parsed['personal-pro'].models.push('gpt-5.9-unpublished')
      }),
    key: 'personal-pro',
    model: 'gpt-5.9-unpublished',
    binding: null,
    reason: 'no_eligible_broker_target',
  },
  {
    name: 'a model in the catalog but outside the grant map withholds the binding',
    cm: () => mappedView(),
    key: 'personal-pro',
    model: 'gpt-5.3-codex',
    binding: null,
    reason: 'no_eligible_broker_target',
  },
  {
    name: 'legacy without a map keeps the flat catalog for a real key',
    cm: () => FIXTURE.legacy,
    key: 'team-plus',
    model: 'gpt-5.3-codex',
    binding: {
      connectionKey: 'team-plus',
      catalogRevision: 4,
      credentialRevision: 2,
      model: 'gpt-5.3-codex',
    },
    reason: 'eligible',
  },
  {
    name: 'legacy that does not list the model withholds the binding',
    cm: () => FIXTURE.legacy,
    key: 'team-plus',
    model: 'gpt-5.9-unpublished',
    binding: null,
    reason: 'no_eligible_broker_target',
  },
  {
    name: 'an unreadable ConfigMap is uncertain, never ineligible',
    cm: () => undefined,
    key: 'team-plus',
    model: 'gpt-5.3-codex',
    binding: null,
    reason: 'snapshot_missing',
    eligibility: 'uncertain',
  },
  {
    name: 'malformed catalog data is uncertain, never ineligible',
    cm: () => ({
      metadata: mappedView().metadata,
      data: { 'codex-subscription': 'not json' },
    }),
    key: 'personal-pro',
    model: 'gpt-5.1',
    binding: null,
    reason: 'snapshot_malformed',
    eligibility: 'uncertain',
  },
  {
    name: 'an unassigned grant never mints a binding',
    cm: () => mappedView(),
    key: 'unassigned',
    model: 'gpt-5.3-codex',
    binding: null,
    reason: 'unassigned',
  },
  {
    name: 'an empty model never mints a binding',
    cm: () => mappedView(),
    key: 'personal-pro',
    model: '   ',
    binding: null,
    reason: 'model_missing',
  },
]

for (const entry of ELIGIBILITY_MATRIX) {
  test(`toEligiblePolicyBinding — ${entry.name}`, () => {
    const result = projection.toEligiblePolicyBinding(entry.cm(), entry.key, entry.model)
    assert.deepEqual(result.binding, entry.binding)
    assert.equal(result.reason, entry.reason)
    assert.equal(
      result.eligibility,
      entry.eligibility ?? (entry.binding ? 'eligible' : 'ineligible')
    )
  })
}

test('toEligiblePolicyBinding withholds the binding when the catalog carries no revisions', () => {
  // Strictly stronger than the scope gate: the execution binding hashes the
  // revisions, so it cannot be minted without them. This is the ONE direction
  // in which the two gates are allowed to differ, and it fails closed — the
  // recipe gets the scope but no binding, so mcp-host stays awaiting_policy.
  const cm = {
    metadata: {
      annotations: {
        'clerum.io/codex-connection-status': 'connected',
        'clerum.io/codex-enabled': 'true',
      },
    },
    data: { 'codex-subscription': JSON.stringify([{ model: 'gpt-5.1', stale: false }]) },
  }
  const result = projection.toEligiblePolicyBinding(cm, 'team-plus', 'gpt-5.1')
  assert.equal(result.binding, null)
  assert.equal(result.reason, 'revision_missing')
  const scoped = projection.projectCodexExecution(
    { model: { provider: projection.CODEX_PROVIDER, name: 'gpt-5.1' } },
    projection.parseAllowedModelsSnapshot(cm, 'team-plus')
  )
  assert.ok(scoped.derivedScopes.includes(projection.CODEX_EXECUTE_SCOPE))
})

test('parity oracle: the execution binding and the execute scope never disagree', () => {
  // The invariant behind unifying the two gates. A binding minted where
  // the scope gate says no is the dangerous direction — the recipe would hold
  // an execution policy the reconciler refuses to authorize — so it is
  // asserted unconditionally. The converse holds for every ConfigMap that
  // carries revisions, which is every ConfigMap the writer emits.
  let checked = 0
  for (const entry of ELIGIBILITY_MATRIX) {
    const cm = entry.cm()
    const { binding } = projection.toEligiblePolicyBinding(cm, entry.key, entry.model)
    const snapshot = projection.parseAllowedModelsSnapshot(cm, entry.key)
    const scoped = projection
      .projectCodexExecution(
        { model: { provider: projection.CODEX_PROVIDER, name: entry.model } },
        snapshot
      )
      .derivedScopes.includes(projection.CODEX_EXECUTE_SCOPE)
    assert.equal(
      binding !== null,
      scoped,
      `${entry.name}: binding=${binding !== null} scope=${scoped}`
    )
    checked += 1
  }
  assert.ok(checked >= ELIGIBILITY_MATRIX.length)
})

test('toPolicyBinding still serves Host chat through a degraded connection', () => {
  // Contract guard for mcp-host's configStore: hardening `toPolicyBinding` in
  // place would wipe a live Host binding on a transient `unavailable`, which is
  // exactly the regression an earlier round closed. The execution gate is a
  // separate function.
  for (const status of ['reauth-required', 'unavailable', 'revoked', 'disconnected']) {
    const cm = withConnections(FIXTURE.mapped, parsed => {
      parsed['personal-pro'].status = status
    })
    assert.deepEqual(projection.toPolicyBinding(cm, 'personal-pro'), {
      catalogRevision: 4,
      credentialRevision: 2,
      connectionKey: 'personal-pro',
      models: ['gpt-5.1'],
    })
    assert.equal(projection.toEligiblePolicyBinding(cm, 'personal-pro', 'gpt-5.1').binding, null)
  }
})
