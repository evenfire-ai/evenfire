'use strict'

// Integration contract for the gate's exported lifecycle. Kubernetes is a
// boundary fake; journals are real, private files in a test-owned directory.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const {
  restore,
  protectedRun,
  fixtureObjects,
  deploymentReady,
  policyObservation,
  acceptPolicyIntentChange,
} = require('../e2e/_lib/wrc-egress-gate.cjs')
const {
  Journal,
  journalPath,
  readJournal,
  RUN_LABEL,
} = require('../e2e/_lib/wrc-egress-lifecycle.cjs')
const { readConfig } = require('../../tests/e2e/fixtures/wrc-egress-dns-proxy/server.cjs')

const source = fs.realpathSync(path.resolve(__dirname, '../..'))
const key = identity => `${identity.kind}/${identity.namespace}/${identity.name}`
const clone = value => (value === undefined ? undefined : structuredClone(value))
const apiError = code => Object.assign(new Error(`fixture API ${code}`), { code })

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wrc-gate-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runId = randomUUID()
  const binding = {
    repository: directory,
    branch: 'fix/unit-gate',
    profile: 'unit-profile',
    context: 'unit-profile',
    head: 'unit-head',
  }
  const injectedConfig = { nameservers: ['10.96.0.20'], options: [{ name: 'timeout', value: '2' }] }
  const wrcIdentity = { kind: 'Deployment', namespace: 'control-plane', name: 'workflow-recipes' }
  const resources = [
    {
      kind: 'ConfigMap',
      namespace: 'control-plane',
      name: 'unit-script',
      attempted: true,
      uid: 'script-uid',
    },
    {
      kind: 'Service',
      namespace: 'control-plane',
      name: 'unit-dns',
      attempted: true,
      uid: 'dns-uid',
    },
    {
      kind: 'Deployment',
      namespace: 'control-plane',
      name: 'unit-proxy',
      attempted: true,
      uid: 'proxy-uid',
    },
    {
      kind: 'WorkflowRecipe',
      namespace: 'sandbox-recipes',
      name: 'unit-recipe',
      attempted: true,
      uid: 'recipe-uid',
    },
  ]
  const state = {
    version: 1,
    runId,
    binding,
    phase: 'exercising',
    resources,
    uiCleanup: null,
    wrc: {
      identity: wrcIdentity,
      uid: 'wrc-uid',
      replicas: 1,
      originalPolicy: 'ClusterFirst',
      injectedConfig,
      attempted: true,
    },
  }
  const file = journalPath(directory, binding.profile)
  const journal = new Journal(file, state)
  const objects = new Map(
    resources.map(entry => [
      key(entry),
      {
        apiVersion: 'v1',
        kind: entry.kind,
        metadata: {
          name: entry.name,
          namespace: entry.namespace,
          uid: entry.uid,
          resourceVersion: '1',
          labels: { [RUN_LABEL]: runId },
        },
      },
    ])
  )
  const wrc = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: wrcIdentity.name,
      namespace: wrcIdentity.namespace,
      uid: state.wrc.uid,
      resourceVersion: '7',
      generation: 2,
    },
    spec: {
      replicas: 1,
      template: { spec: { dnsPolicy: 'None', dnsConfig: clone(injectedConfig) } },
    },
    status: { observedGeneration: 2, readyReplicas: 1, availableReplicas: 1 },
  }
  objects.set(key(wrcIdentity), wrc)
  const events = []
  const hooks = {}
  const kube = {
    setCleanup(enabled) {
      events.push({ action: 'cleanup', enabled })
    },
    async get(identity) {
      events.push({ action: 'get', identity: clone(identity) })
      if (hooks.get) {
        const result = await hooks.get(identity)
        if (result !== undefined) return clone(result)
      }
      return clone(objects.get(key(identity)) ?? null)
    },
    async list(kind, namespace, selector) {
      events.push({ action: 'list', kind, namespace, selector })
      if (hooks.list) {
        const result = await hooks.list(kind, namespace, selector)
        if (result !== undefined) return clone(result)
      }
      const singular = new Map([
        ['deployments', 'Deployment'],
        ['services', 'Service'],
        ['networkpolicies', 'NetworkPolicy'],
        ['pods', 'Pod'],
        ['replicasets', 'ReplicaSet'],
      ]).get(kind)
      const labels = selector.split(',').map(pair => pair.split('='))
      return [...objects.values()]
        .filter(
          object =>
            object.kind === singular &&
            object.metadata.namespace === namespace &&
            labels.every(([name, value]) => object.metadata.labels?.[name] === value)
        )
        .map(clone)
    },
    async patch(identity, patch) {
      events.push({ action: 'patch', identity: clone(identity), patch: clone(patch) })
      if (hooks.patch) await hooks.patch(identity, patch)
      const live = objects.get(key(identity))
      for (const operation of patch) {
        if (operation.op === 'test' && operation.path === '/metadata/uid')
          assert.equal(operation.value, live.metadata.uid)
        else if (operation.op === 'test' && operation.path === '/metadata/resourceVersion')
          assert.equal(operation.value, live.metadata.resourceVersion)
        else if (operation.op === 'replace' && operation.path === '/spec/template/spec/dnsPolicy')
          live.spec.template.spec.dnsPolicy = operation.value
        else if (operation.op === 'remove' && operation.path === '/spec/template/spec/dnsConfig')
          delete live.spec.template.spec.dnsConfig
        else throw new Error('unexpected mutation in restoration contract')
      }
      live.metadata.resourceVersion = String(Number(live.metadata.resourceVersion) + 1)
      live.metadata.generation++
      return clone(live)
    },
    async rollout(namespace, name) {
      events.push({ action: 'rollout', namespace, name })
      const live = objects.get(key({ kind: 'Deployment', namespace, name }))
      if (hooks.rollout) await hooks.rollout(live)
      live.status = {
        observedGeneration: live.metadata.generation,
        readyReplicas: live.spec.replicas,
        availableReplicas: live.spec.replicas,
      }
    },
    async delete(identity, preconditions) {
      events.push({
        action: 'delete',
        identity: clone(identity),
        preconditions: clone(preconditions),
      })
      if (hooks.delete) await hooks.delete(identity, preconditions)
      const live = objects.get(key(identity))
      assert.equal(preconditions.uid, live.metadata.uid)
      assert.equal(preconditions.resourceVersion, live.metadata.resourceVersion)
      objects.delete(key(identity))
    },
  }
  return { directory, file, journal, state, wrc, objects, kube, hooks, events, wrcIdentity }
}

const mutations = events =>
  events.filter(event => event.action === 'patch' || event.action === 'delete')

function uiFixture(t, { assigned = true, children = true } = {}) {
  const fixtureState = fixture(t)
  const { state, objects, journal } = fixtureState
  const parent = state.resources.find(entry => entry.kind === 'WorkflowRecipe')
  const parentObject = objects.get(key(parent))
  parentObject.spec = {
    ui: { workloadRef: 'frontend' },
    workloads: [{ id: 'frontend', type: 'deployment', port: 3000 }],
  }
  const physicalName = 'wf-unit-recipe-frontend-a17c5e92'
  if (assigned)
    parentObject.status = { workloadInstances: { frontend: physicalName }, phase: 'candidate' }
  state.uiCleanup = {
    parent: { kind: parent.kind, name: parent.name, namespace: parent.namespace },
    parentUid: parent.uid,
    runId: state.runId,
    namespace: 'sandbox-ui',
    workload: 'frontend',
    physicalName: null,
    children: [],
  }
  const common = { 'clerum.io/managed-by': 'workflow-recipes', 'clerum.io/recipe': parent.name }
  const uiLabels = {
    'clerum.io/sandbox-ui': 'true',
    'clerum.io/recipe-name': parent.name,
    'clerum.io/recipe-namespace': parent.namespace,
  }
  const uiObjects = [
    {
      kind: 'Deployment',
      metadata: {
        name: physicalName,
        namespace: 'sandbox-ui',
        uid: 'ui-deployment-uid',
        resourceVersion: '10',
        labels: { ...common, 'clerum.io/workload': 'frontend' },
      },
    },
    {
      kind: 'Service',
      metadata: {
        name: physicalName,
        namespace: 'sandbox-ui',
        uid: 'ui-service-uid',
        resourceVersion: '11',
        labels: { ...common, ...uiLabels, 'clerum.io/workload': 'frontend' },
      },
    },
    {
      kind: 'NetworkPolicy',
      metadata: {
        name: `ui-egress-${parent.name}`,
        namespace: 'sandbox-ui',
        uid: 'ui-policy-uid',
        resourceVersion: '12',
        labels: {
          ...common,
          'clerum.io/recipe-name': parent.name,
          'clerum.io/recipe-namespace': parent.namespace,
        },
      },
    },
  ]
  if (children)
    for (const object of uiObjects)
      objects.set(key({ kind: object.kind, ...object.metadata }), object)
  journal.save()
  return { ...fixtureState, parent, parentObject, physicalName, uiObjects }
}

test('foreground recipe deletion cannot leave UI children after its finalizer swallows DELETE503', async t => {
  const { kube, journal, objects, hooks, file, events, parent, physicalName, uiObjects } =
    uiFixture(t)
  const rawCollision = {
    kind: 'Deployment',
    metadata: {
      name: 'frontend',
      namespace: 'sandbox-ui',
      uid: 'unrelated-uid',
      resourceVersion: '1',
      labels: { 'clerum.io/recipe': 'unrelated' },
    },
  }
  objects.set('Deployment/sandbox-ui/frontend', rawCollision)
  let recordedBeforeParentDeletion = false
  hooks.delete = identity => {
    if (identity.kind === 'WorkflowRecipe') {
      const saved = readJournal(file).uiCleanup
      recordedBeforeParentDeletion =
        saved.physicalName === physicalName &&
        saved.parentUid === parent.uid &&
        uiObjects.every(object => saved.children.some(child => child.uid === object.metadata.uid))
      // Real WRC safeDelete absorbs the simulated UI DELETE503, removes its
      // finalizer, and allows parent deletion; the cross-namespace objects stay.
    }
  }
  await restore(kube, journal)
  assert.equal(recordedBeforeParentDeletion, true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(objects.get('Deployment/sandbox-ui/frontend'), rawCollision)
  for (const object of uiObjects) {
    assert.equal(objects.has(key({ kind: object.kind, ...object.metadata })), false)
    const deletion = events.find(
      event =>
        event.action === 'delete' &&
        event.identity.kind === object.kind &&
        event.identity.namespace === 'sandbox-ui'
    )
    assert.deepEqual(deletion.preconditions, {
      uid: object.metadata.uid,
      resourceVersion: object.metadata.resourceVersion,
    })
  }
  assert.equal(
    events.some(
      event => event.identity?.namespace === 'sandbox-ui' && event.identity.name === 'frontend'
    ),
    false
  )
})

test('failed leftover delete preserves recorded UI identities for recovery after the parent is absent', async t => {
  const { kube, journal, hooks, file, objects, parent, uiObjects } = uiFixture(t)
  hooks.delete = identity => {
    if (identity.namespace === 'sandbox-ui') throw apiError(503)
  }
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  const saved = readJournal(file)
  assert.equal(saved.phase, 'recovery-required')
  assert.equal(objects.has(key(parent)), false)
  assert(saved.uiCleanup.children.some(child => child.uid === 'ui-deployment-uid'))
  hooks.delete = undefined
  await restore(kube, new Journal(file, saved, true))
  assert.equal(fs.existsSync(file), false)
  for (const object of uiObjects)
    assert.equal(objects.has(key({ kind: object.kind, ...object.metadata })), false)
})

test('a replaced UI UID is never adopted during recovery, even with matching name and labels', async t => {
  const { kube, journal, hooks, file, events, uiObjects } = uiFixture(t)
  hooks.delete = identity => {
    if (identity.kind === 'WorkflowRecipe') uiObjects[0].metadata.uid = 'replacement-uid'
  }
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(
    readJournal(file).uiCleanup.children.find(child => child.kind === 'Deployment').uid,
    'ui-deployment-uid'
  )
  assert.equal(
    events.some(event => event.action === 'delete' && event.identity.namespace === 'sandbox-ui'),
    false
  )
  await assert.rejects(
    restore(kube, new Journal(file, readJournal(file), true)),
    /WRC_EGRESS_RECOVERY_REQUIRED/
  )
  assert.equal(
    events.some(event => event.action === 'delete' && event.identity.namespace === 'sandbox-ui'),
    false
  )
})

test('a foreign UI owner is refused before deleting its parent or any UI resource', async t => {
  const { kube, journal, uiObjects, events, file } = uiFixture(t)
  uiObjects[0].metadata.labels['clerum.io/recipe'] = 'foreign-recipe'
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(file).phase, 'recovery-required')
  assert.equal(
    events.some(event => event.action === 'delete'),
    false
  )
})

test('optional Deployment UI labels may be absent but cannot contradict the parent scope', async t => {
  const { kube, journal, uiObjects, events, file } = uiFixture(t)
  uiObjects[0].metadata.labels['clerum.io/recipe-namespace'] = 'foreign-namespace'
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(file).phase, 'recovery-required')
  assert.equal(
    events.some(event => event.action === 'delete'),
    false
  )
})

test('UI discovery read503 retains recovery-required; authoritative absence before Ready is a valid no-op', async t => {
  const failed = uiFixture(t)
  failed.hooks.get = identity => {
    if (identity.namespace === 'sandbox-ui') throw apiError(503)
  }
  await assert.rejects(restore(failed.kube, failed.journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(failed.file).phase, 'recovery-required')
  assert.equal(
    failed.events.some(event => event.action === 'delete'),
    false
  )
  for (const assigned of [false, true]) {
    const absent = uiFixture(t, { assigned, children: false })
    await restore(absent.kube, absent.journal)
    assert.equal(fs.existsSync(absent.file), false)
    assert.equal(
      absent.events.some(
        event => event.action === 'delete' && event.identity.namespace === 'sandbox-ui'
      ),
      false
    )
    assert.equal(
      absent.events.some(event => event.identity?.name === 'frontend'),
      false
    )
  }
})

test('parent already absent without child UID capture cannot certify or adopt an orphan UI', async t => {
  const { kube, journal, parent, objects, file, events } = uiFixture(t)
  objects.delete(key(parent))
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(file).phase, 'recovery-required')
  assert.equal(
    events.some(event => event.action === 'delete' && event.identity.namespace === 'sandbox-ui'),
    false
  )
  const empty = uiFixture(t, { assigned: false, children: false })
  empty.objects.delete(key(empty.parent))
  await restore(empty.kube, empty.journal)
  assert.equal(fs.existsSync(empty.file), false)
})

test('invalid physical names from status are refused before they reach a Kubernetes argument', async t => {
  const { kube, journal, parentObject, events, file } = uiFixture(t)
  parentObject.status.workloadInstances.frontend = '--context=foreign'
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(
    events.some(event => event.identity?.name === '--context=foreign'),
    false
  )
  assert.equal(
    events.some(event => event.action === 'delete'),
    false
  )
  assert.equal(readJournal(file).phase, 'recovery-required')
})

test('UI census errors cannot clear the journal after acknowledged child deletion', async t => {
  const { kube, journal, hooks, file } = uiFixture(t)
  hooks.list = () => {
    throw apiError(503)
  }
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(file).phase, 'recovery-required')
})

test('an old journal with recipe deletion but no UI cleanup declaration cannot certify absence', async t => {
  const { kube, journal, state, file, events } = fixture(t)
  delete state.uiCleanup
  journal.save()
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(file).phase, 'recovery-required')
  assert.equal(
    events.some(event => event.action === 'delete'),
    false
  )
})

test('a UI child first appearing after parent deletion has no adoptable recorded UID', async t => {
  const { kube, journal, hooks, objects, uiObjects, file, events } = uiFixture(t, {
    children: false,
  })
  hooks.delete = identity => {
    if (identity.kind === 'WorkflowRecipe') {
      objects.set(key({ kind: uiObjects[0].kind, ...uiObjects[0].metadata }), uiObjects[0])
    }
  }
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(
    readJournal(file).uiCleanup.children.find(child => child.kind === 'Deployment').uid,
    null
  )
  assert.equal(
    events.some(event => event.action === 'delete' && event.identity.namespace === 'sandbox-ui'),
    false
  )
})

test('a foreign parent UID cannot authorize capturing or deleting its UI children', async t => {
  const { kube, journal, parentObject, file, events } = uiFixture(t)
  parentObject.metadata.uid = 'foreign-parent-uid'
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(file).phase, 'recovery-required')
  assert.equal(
    events.some(event => event.action === 'delete'),
    false
  )
})

test('UI background ReplicaSets and Pods must disappear before the journal is removed', async t => {
  const { kube, journal, hooks, objects, parent, physicalName, events, file } = uiFixture(t)
  for (const kind of ['ReplicaSet', 'Pod']) {
    const name = `${physicalName}-${kind.toLowerCase()}`
    objects.set(`${kind}/sandbox-ui/${name}`, {
      kind,
      metadata: {
        name,
        namespace: 'sandbox-ui',
        uid: `${kind}-uid`,
        labels: { 'clerum.io/recipe': parent.name },
      },
    })
  }
  hooks.list = kind => {
    const singular = kind === 'replicasets' ? 'ReplicaSet' : kind === 'pods' ? 'Pod' : null
    if (!singular) return undefined
    const lingering = [...objects.values()].filter(object => object.kind === singular)
    for (const object of lingering)
      objects.delete(`${object.kind}/${object.metadata.namespace}/${object.metadata.name}`)
    return lingering
  }
  await restore(kube, journal)
  assert.equal(fs.existsSync(file), false)
  assert(events.filter(event => event.action === 'list' && event.kind === 'pods').length >= 2)
  assert.equal(
    events.some(
      event => event.action === 'delete' && ['Pod', 'ReplicaSet'].includes(event.identity.kind)
    ),
    false
  )
})

test('recovery requires a newer controller observation for every retained tuple, not old policy or DNS counters', () => {
  const policy = entries => ({
    metadata: {
      annotations: {
        'clerum.io/egress-fqdn-state': JSON.stringify(entries),
      },
    },
  })
  const retained = [
    { lastObservedAt: 100, expiresAt: 500 },
    { lastObservedAt: 101, expiresAt: 510 },
  ]
  assert.deepEqual(policyObservation(policy(retained)), { lastAcceptedAt: 101, latestExpiry: 510 })
  assert.equal(policyObservation(policy(retained), 100), null)
  assert.equal(policyObservation(policy(retained), 101), null)
  assert.deepEqual(policyObservation(policy([{ lastObservedAt: 102, expiresAt: 600 }]), 101), {
    lastAcceptedAt: 102,
    latestExpiry: 600,
  })
  assert.throws(() => policyObservation(policy([])), /MISSING_ACCEPTED/)
  assert.throws(
    () => policyObservation(policy([{ lastObservedAt: null, expiresAt: 600 }])),
    /MISSING_ACCEPTED/
  )
})

test('only confirmed same-recipe intent change releases policy UID pins for a fully reproven migration', () => {
  const targets = [
    { lane: 'ui', fqdn: 'ui.example.com' },
    { lane: 'worker', fqdn: 'worker.example.com' },
  ]
  const before = { metadata: { uid: 'recipe-uid', generation: 7 } }
  for (const after of [
    { metadata: { uid: 'recipe-uid', generation: 7 } },
    { metadata: { uid: 'foreign-uid', generation: 8 } },
  ]) {
    const lanes = [
      { lane: 'ui', uid: 'ui-policy-uid' },
      { lane: 'workload', uid: 'worker-policy-uid' },
    ]
    assert.throws(
      () => acceptPolicyIntentChange(lanes, before, after, 'recipe-uid', targets),
      /HOST_MIGRATION_NOT_APPLIED/
    )
    assert.deepEqual(
      lanes.map(lane => lane.uid),
      ['ui-policy-uid', 'worker-policy-uid']
    )
  }
  const lanes = [
    { lane: 'ui', uid: 'ui-policy-uid' },
    { lane: 'workload', uid: 'worker-policy-uid' },
  ]
  acceptPolicyIntentChange(
    lanes,
    before,
    { metadata: { uid: 'recipe-uid', generation: 8 } },
    'recipe-uid',
    targets
  )
  assert.deepEqual(
    lanes.map(lane => lane.uid),
    [undefined, undefined]
  )
  assert.deepEqual(
    lanes.map(lane => lane.target.fqdn),
    ['worker.example.com', 'ui.example.com']
  )
})

test('restores exact DNS fields with CAS and proves rollout before deleting owned resources', async t => {
  const { kube, journal, file, wrc, events, state } = fixture(t)
  await restore(kube, journal)
  assert.equal(wrc.spec.template.spec.dnsPolicy, 'ClusterFirst')
  assert.equal(wrc.spec.template.spec.dnsConfig, undefined)
  assert.equal(deploymentReady(wrc), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(state.phase, 'restored')
  assert.deepEqual(events[0], { action: 'cleanup', enabled: true })
  const patch = events.find(event => event.action === 'patch').patch
  assert.deepEqual(patch.slice(0, 2), [
    { op: 'test', path: '/metadata/uid', value: 'wrc-uid' },
    { op: 'test', path: '/metadata/resourceVersion', value: '7' },
  ])
  assert.deepEqual(
    events.filter(event => event.action === 'delete').map(event => event.identity.name),
    ['unit-recipe', 'unit-proxy', 'unit-dns', 'unit-script']
  )
  const firstDelete = events.findIndex(event => event.action === 'delete')
  assert(events.slice(0, firstDelete).some(event => event.action === 'rollout'))
})

test('restoration recognizes already restored default DNS without rewriting it', async t => {
  const { kube, journal, wrc, events, file } = fixture(t)
  delete wrc.spec.template.spec.dnsPolicy
  delete wrc.spec.template.spec.dnsConfig
  await restore(kube, journal)
  assert.equal(
    events.some(event => event.action === 'patch'),
    false
  )
  assert.equal(fs.existsSync(file), false)
})

for (const scenario of [
  'uid',
  'replicas',
  'dns',
  'absent',
  'read-error',
  'patch-conflict',
  'rollout-error',
  'readback-drift',
]) {
  test(`uncertain ${scenario} restoration retains every DNS resource and the recovery journal`, async t => {
    const { kube, journal, wrc, events, hooks, file, wrcIdentity, objects } = fixture(t)
    if (scenario === 'uid') wrc.metadata.uid = 'foreign-wrc'
    if (scenario === 'replicas') wrc.spec.replicas = 2
    if (scenario === 'dns') wrc.spec.template.spec.dnsConfig = { nameservers: ['10.96.0.99'] }
    if (scenario === 'absent') objects.delete(key(wrcIdentity))
    if (scenario === 'read-error')
      hooks.get = () => {
        throw apiError(503)
      }
    if (scenario === 'patch-conflict')
      hooks.patch = () => {
        throw apiError(409)
      }
    if (scenario === 'rollout-error')
      hooks.rollout = () => {
        throw apiError(503)
      }
    if (scenario === 'readback-drift')
      hooks.rollout = live => {
        live.spec.template.spec.dnsConfig = { nameservers: ['10.96.0.99'] }
      }
    await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
    assert.equal(readJournal(file).phase, 'recovery-required')
    assert.equal(readJournal(file).wrc.attempted, true)
    assert.equal(
      events.some(event => event.action === 'delete'),
      false
    )
    if (['uid', 'replicas', 'dns', 'absent', 'read-error'].includes(scenario))
      assert.equal(mutations(events).length, 0)
  })
}

test('replica changes during restoration readback cannot be certified as baseline restored', async t => {
  const { kube, journal, hooks, file, events } = fixture(t)
  hooks.rollout = live => {
    live.spec.replicas = 2
  }
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(file).phase, 'recovery-required')
  assert.equal(
    events.some(event => event.action === 'delete'),
    false
  )
})

test('an unmutated failed preflight produces no resource write and removes only its own journal', async t => {
  const { kube, journal, state, file, events } = fixture(t)
  state.resources = []
  delete state.wrc
  journal.save()
  const original = new Error('ownership/precondition refused')
  await assert.rejects(
    protectedRun(
      kube,
      journal,
      async () => {
        throw original
      },
      new AbortController()
    ),
    error => error === original
  )
  assert.equal(mutations(events).length, 0)
  assert.equal(fs.existsSync(file), false)
})

test('partial creation before DNS injection deletes only acknowledged existing identities', async t => {
  const { kube, journal, state, objects, file, events } = fixture(t)
  state.wrc.attempted = false
  state.resources = state.resources.slice(0, 2)
  objects.delete(key(state.resources[1]))
  state.resources[1].uid = null
  journal.save()
  await restore(kube, journal)
  assert.deepEqual(
    mutations(events).map(event => `${event.action}:${event.identity.name}`),
    ['delete:unit-script']
  )
  assert.equal(fs.existsSync(file), false)
})

for (const conflict of ['uid', 'label', 'unacknowledged']) {
  test(`cleanup refuses ${conflict} ownership while preserving a recovery obligation`, async t => {
    const { kube, journal, state, objects, file, events } = fixture(t)
    state.wrc.attempted = false
    const foreign = state.resources[0]
    const live = objects.get(key(foreign))
    if (conflict === 'uid') live.metadata.uid = 'replacement-resource'
    if (conflict === 'label') live.metadata.labels[RUN_LABEL] = randomUUID()
    if (conflict === 'unacknowledged') foreign.uid = null
    journal.save()
    await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
    assert.equal(
      events.some(event => event.action === 'delete' && event.identity.name === foreign.name),
      false
    )
    assert.equal(objects.has(key(foreign)), true)
    assert.equal(readJournal(file).phase, 'recovery-required')
  })
}

test('an unavailable cleanup GET cannot be confused with confirmed resource absence', async t => {
  const { kube, journal, hooks, state, file, events } = fixture(t)
  state.wrc.attempted = false
  hooks.get = identity => {
    if (identity.kind === 'Service') throw apiError(503)
  }
  await assert.rejects(restore(kube, journal), /WRC_EGRESS_RECOVERY_REQUIRED/)
  assert.equal(readJournal(file).phase, 'recovery-required')
  assert.equal(
    events.some(event => event.action === 'delete' && event.identity.kind === 'Service'),
    false
  )
})

test('failed exercise is preserved after successful restoration; cleanup failure includes both causes', async t => {
  const first = fixture(t)
  const original = new Error('business assertion failed')
  await assert.rejects(
    protectedRun(
      first.kube,
      first.journal,
      async () => {
        throw original
      },
      new AbortController()
    ),
    error => error === original
  )
  assert.equal(fs.existsSync(first.file), false)
  const second = fixture(t)
  second.hooks.rollout = () => {
    throw apiError(503)
  }
  await assert.rejects(
    protectedRun(
      second.kube,
      second.journal,
      async () => {
        throw original
      },
      new AbortController()
    ),
    error =>
      error instanceof AggregateError && error.errors[0] === original && error.errors.length === 2
  )
  assert.equal(readJournal(second.file).phase, 'recovery-required')
})

for (const exitCode of [130, 143]) {
  for (const timing of ['exercise', 'restoration']) {
    test(`interruption ${exitCode} during ${timing} cannot become a green protected run`, async t => {
      const { kube, journal, hooks, file, events } = fixture(t)
      const cancellation = new AbortController()
      const interruption = Object.assign(new Error('interrupted'), { exitCode })
      if (timing === 'restoration') hooks.rollout = () => cancellation.abort(interruption)
      await assert.rejects(
        protectedRun(
          kube,
          journal,
          async () => {
            if (timing === 'exercise') cancellation.abort(interruption)
          },
          cancellation
        ),
        error => error === interruption
      )
      assert.equal(fs.existsSync(file), false)
      assert.equal(events.filter(event => event.action === 'delete').length, 4)
    })
  }
}

test('fixture manifests preserve distinct DNS lanes, scoped policies and a valid independent exact-host canary', () => {
  const config = {
    repository: source,
    wrcNamespace: 'control-plane',
    wrcDeployment: 'workflow-recipes',
    recipeNamespace: 'sandbox-recipes',
    uiNamespace: 'sandbox-ui',
  }
  const runId = randomUUID()
  const result = fixtureObjects(config, runId, 'wrc:test', '93.184.216.34', '10.96.0.10')
  for (const object of [...result.objects, result.recipe, result.canary])
    assert.equal(object.metadata.labels[RUN_LABEL], runId)
  const proxy = result.objects.find(object => object.kind === 'Deployment')
  const container = proxy.spec.template.spec.containers[0]
  const env = Object.fromEntries(container.env.map(entry => [entry.name, entry.value]))
  const dnsConfig = readConfig(env)
  assert.deepEqual(dnsConfig.targets.map(target => target.lane).sort(), ['canary', 'ui', 'worker'])
  assert.equal(new Set(dnsConfig.targets.map(target => target.fqdn)).size, 3)
  assert.equal(proxy.spec.template.spec.automountServiceAccountToken, false)
  assert.equal(container.securityContext.allowPrivilegeEscalation, false)
  const witness = result.canary.spec.workloads[0]
  assert.equal(witness.transport, undefined)
  const canaryTarget = dnsConfig.targets.find(target => target.lane === 'canary')
  assert.deepEqual(
    witness.egressBindings,
    [80, 443].map(port => ({ dns: canaryTarget.fqdn, port, protocol: 'TCP' }))
  )
  assert.deepEqual(
    result.recipe.spec.ui.egress.internal,
    [3000, 3001].map(port => ({ workloadRef: 'worker', port }))
  )
  for (const workload of result.recipe.spec.workloads) {
    assert.equal(workload.port, 3000)
    assert.equal(workload.healthCheck.port, 3001)
  }
  const fromWrc = result.objects.find(object => object.metadata.name === result.names.fromWrc)
  assert.deepEqual(fromWrc.spec.podSelector, { matchLabels: { app: config.wrcDeployment } })
  assert.deepEqual(fromWrc.spec.egress[0].to, [
    { podSelector: { matchLabels: { app: result.names.proxy } } },
  ])
})
