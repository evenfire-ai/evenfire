import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertCatalogUnchanged, assertHeldRuntime, assertLiveHold, assertPostWrite,
  assertRollout, digest, projectRuntime, readBoundRecord, validateBarrierDirectory,
  validateCatalog, validatePreparation,
} from '../e2e/_lib/canonical-store-lifecycle.mjs'

const hostUid = '825-source-host'
const pvcUid = '825-source-pvc'
const storeId = '30000000-0000-4000-8000-000000000001'
const runId = '30000000-0000-4000-8000-000000000002'
const migrationId = '30000000-0000-4000-8000-000000000003'
const row = (id, value) => ({ id, sha256: digest(value) })
function catalog(canonical = true) {
  return { schemaVersion: 1, hostUid, pvcUid, databasePath: '/var/lib/clerum/state/state.db',
    catalogHash: digest({ completeBusinessState: 'accepted before cutover' }),
    tableHashes: { sessions: digest('session'), messages: digest('message'), pending_approvals: digest('approval'), sqlite_sequence: digest('sequence') },
    counts: { sessions: 1, messages: 1, pending_approvals: 1, sqlite_sequence: 1 },
    ids: { sessions: ['session-1'], messages: ['1'], pending_approvals: ['approval-1'] },
    rowHashes: { sessions: [row('session-1', { owner: 'synthetic-owner', state: 'idle' })], messages: [row('1', { role: 'user', contentParts: [] })], pending_approvals: [row('approval-1', { parameters: 'synthetic-unit-fixture' })] },
    identity: canonical ? { hostUid, pvcUid, storeId, layoutVersion: 1 } : null,
  }
}
function runtime() {
  return { hostUid, pvcUid, storeId, migrationId, podUid: 'pod-before', templateHash: digest('before'), writerPods: 1, stateless: true }
}
test('complete catalog/IDs survive creation of identity; loss of any business field fails', () => {
  const before = catalog(false), after = catalog(true)
  assert.doesNotThrow(() => assertCatalogUnchanged(before, after, true))
  for (const table of ['sessions', 'messages', 'pending_approvals', 'sqlite_sequence']) {
    const changed = structuredClone(after)
    changed.tableHashes[table] = digest({ mutatedTable: table })
    assert.throws(() => assertCatalogUnchanged(before, changed, true))
  }
  const changedId = structuredClone(after); changedId.ids.messages = ['2']
  assert.throws(() => assertCatalogUnchanged(before, changedId, true))
  const changedRow = structuredClone(after); changedRow.rowHashes.messages[0].sha256 = digest('changed attachment')
  assert.throws(() => assertCatalogUnchanged(before, changedRow, true))
})
test('postwrite needs durable new rows and preserves every old message row/ID and store identity', () => {
  const before = catalog(), after = structuredClone(before)
  after.catalogHash = digest('new accepted turn')
  after.counts.messages = 2; after.ids.messages.push('2'); after.rowHashes.messages.push(row('2', 'after-cutover'))
  assert.doesNotThrow(() => assertPostWrite(before, after))
  assert.throws(() => assertPostWrite(before, before), /accepted message/)
  const lost = structuredClone(after); lost.ids.messages.shift()
  assert.throws(() => assertPostWrite(before, lost), /lost messages/)
  const rewritten = structuredClone(after); rewritten.rowHashes.messages[0].sha256 = digest('rewrite')
  assert.throws(() => assertPostWrite(before, rewritten))
  const rebound = structuredClone(after); rebound.identity.storeId = runId
  assert.throws(() => assertPostWrite(before, rebound))
})
test('expired, stale or zero-cut authority holds cannot substitute for live hold proof', () => {
  const hold = { id: 'cut-1', state: 'held', cut: 1, deadlineAtMs: 2000 }
  assert.doesNotThrow(() => assertLiveHold(hold, 'cut-1', 1000))
  assert.throws(() => assertLiveHold(hold, 'cut-1', 2000))
  assert.throws(() => assertLiveHold(hold, 'another-cut', 1000))
  assert.throws(() => assertLiveHold({ ...hold, cut: 0 }, 'cut-1', 1000))
  assert.throws(() => assertLiveHold({ ...hold, state: 'released' }, 'cut-1', 1000))
})
test('hold requires unchanged actual Pod/template; confirmed rollout requires both changes and actual mode', () => {
  const before = runtime()
  assert.doesNotThrow(() => assertHeldRuntime(before, structuredClone(before)))
  for (const key of ['hostUid', 'pvcUid', 'podUid', 'templateHash', 'storeId', 'migrationId']) {
    assert.throws(() => assertHeldRuntime(before, { ...before, [key]: 'mutated' }))
  }
  assert.throws(() => assertHeldRuntime(before, { ...before, writerPods: 2 }))
  const after = { ...before, podUid: 'pod-after', templateHash: digest('after'), stateless: false }
  assert.doesNotThrow(() => assertRollout(before, after, false))
  assert.throws(() => assertRollout(before, { ...after, podUid: before.podUid }, false))
  assert.throws(() => assertRollout(before, { ...after, templateHash: before.templateHash }, false))
  assert.throws(() => assertRollout(before, after, true))
})
test('full catalog binding/schema/ID counts and genuine absence of canonical identity are mandatory', () => {
  assert.doesNotThrow(() => validateCatalog(catalog(), { hostUid, pvcUid }, true))
  assert.doesNotThrow(() => validateCatalog(catalog(false), { hostUid, pvcUid }, false))
  assert.throws(() => validateCatalog(catalog(), { hostUid, pvcUid }, false))
  assert.throws(() => validateCatalog(catalog(false), { hostUid, pvcUid }, true))
  assert.throws(() => validateCatalog(catalog(), { hostUid: 'retained-other-host', pvcUid }, true))
  const duplicate = catalog(); duplicate.ids.messages = ['1', '1']; duplicate.counts.messages = 2
  assert.throws(() => validateCatalog(duplicate, { hostUid, pvcUid }, true))
})
test('diagnostic target pins do not accept a different binding, floor hint, blank revision or unknown source', () => {
  const preparation = { schemaVersion: 1, hostUid, pvcUid, storageContract: 'canonical', sourceClass: 'sqlite-pvc',
    targetImage: 'clerum/mcp-host:test', templateRevision: digest('real-controller-proposal'), manifestHash: digest('actual-inventory'), maintenanceId: runId }
  assert.doesNotThrow(() => validatePreparation(preparation, hostUid, pvcUid))
  for (const changed of [{ hostUid: 'another-host' }, { pvcUid: 'retained-pvc' }, { storageContract: 'legacy-floor' }, { sourceClass: 'unknown' }, { templateRevision: '' }]) {
    assert.throws(() => validatePreparation({ ...preparation, ...changed }, hostUid, pvcUid))
  }
})
function workload() {
  const values = { CLERUM_SESSION_DB_DIR: '/var/lib/clerum/state', CLERUM_HOST_UID: hostUid,
    CLERUM_PVC_UID: pvcUid, CLERUM_CANONICAL_STORE_CONTRACT: 'canonical', CLERUM_CANONICAL_STORE_REQUIRED: 'true', CLERUM_STATELESS_LIFECYCLE: 'true' }
  return {
    host: { metadata: { uid: hostUid }, spec: { lifecycle: { stateless: true } }, status: { conversationStore: {
      compatibility: { pvcUid, migrationId }, layout: { storeId }, operationOutcome: { migrationId } } } },
    pvc: { metadata: { uid: pvcUid, name: 'synthetic-pvc' } },
    deployment: { metadata: { uid: 'deployment-1', ownerReferences: [{ controller: true, uid: hostUid }] }, spec: {
      strategy: { type: 'Recreate' }, template: { spec: { volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'synthetic-pvc' } }],
        containers: [{ name: 'mcp-host', image: 'clerum/mcp-host:test', env: Object.entries(values).map(([name, value]) => ({ name, value })),
          volumeMounts: [{ name: 'workspace', mountPath: '/workspace', subPath: 'workspace' }, { name: 'workspace', mountPath: '/var/lib/clerum/state', subPath: 'state' }] }] } } } },
    replicasets: { items: [{ metadata: { uid: 'replicaset-1', ownerReferences: [{ uid: 'deployment-1', controller: true }] } }] },
    pods: { items: [{ metadata: { uid: 'pod-1', name: 'synthetic-pod', ownerReferences: [{ uid: 'replicaset-1', controller: true }] }, status: {
      conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'mcp-host', imageID: 'containerd://sha256:synthetic-unit-id', state: { running: {} } }] } }] },
  }
}
test('native owner chain, full contract mounts, Recreate and every live runtime container are checked', () => {
  assert.equal(projectRuntime(workload()).writerPods, 1)
  const old = workload(); old.pods.items.push(structuredClone(old.pods.items[0])); old.pods.items[1].metadata.deletionTimestamp = '2026-10-01T00:00:00Z'
  assert.throws(() => projectRuntime(old), /exactly one/)
  const badOwner = workload(); badOwner.replicasets.items[0].metadata.ownerReferences[0].uid = 'other-deployment'
  assert.throws(() => projectRuntime(badOwner))
  const rootMount = workload(); delete rootMount.deployment.spec.template.spec.containers[0].volumeMounts[1].subPath
  assert.throws(() => projectRuntime(rootMount))
  const unready = workload(); unready.pods.items[0].status.conditions[0].status = 'False'
  assert.throws(() => projectRuntime(unready))
  assert.doesNotThrow(() => projectRuntime(unready, true))
})
test('private same-run UI barriers reject stale ACKs, symlinks and unsafe permissions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-barrier-contract-'))
  fs.chmodSync(directory, 0o700)
  try {
    fs.writeFileSync(path.join(directory, 'binding.json'), JSON.stringify({ runId }), { mode: 0o600 })
    assert.equal(validateBarrierDirectory(directory, runId), fs.realpathSync(directory))
    assert.throws(() => validateBarrierDirectory(directory, storeId))
    const record = path.join(directory, '1.ack.json')
    fs.writeFileSync(record, JSON.stringify({ runId, sequence: 1, phase: 'canonical-activated', uiVerified: true }), { mode: 0o600 })
    assert.doesNotThrow(() => readBoundRecord(record, { runId, sequence: 1, uiVerified: true }))
    assert.throws(() => readBoundRecord(record, { runId, sequence: 2 }))
    const link = path.join(directory, 'alias.ack.json'); fs.symlinkSync(record, link)
    assert.throws(() => readBoundRecord(link, { runId }))
    fs.chmodSync(record, 0o644); assert.throws(() => readBoundRecord(record, { runId }))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
