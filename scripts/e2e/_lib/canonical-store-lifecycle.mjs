import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { readCanonicalStoreRecord } from './canonical-store-record.cjs'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
export function digest(value) { return createHash('sha256').update(stableJson(value)).digest('hex') }

export function validatePreparation(value, hostUid, pvcUid) {
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.hostUid, hostUid, 'preparation Host binding')
  assert.equal(value.pvcUid, pvcUid, 'preparation PVC binding')
  assert.equal(value.storageContract, 'canonical')
  assert.equal(value.sourceClass, 'sqlite-pvc', 'this lane requires an admitted on-PVC legacy floor')
  assert.match(value.targetImage || '', /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,2047}$/)
  assert.match(value.templateRevision || '', HASH)
  assert.match(value.manifestHash || '', HASH)
  assert.match(value.maintenanceId || '', UUID)
  // This is a diagnostic/operator input, never an authority receipt. The API
  // establishes the administrator principal and HCC remeasures all pins.
  return value
}
export function validateCatalog(value, binding, canonical) {
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.hostUid, binding.hostUid)
  assert.equal(value.pvcUid, binding.pvcUid)
  assert.equal(value.databasePath, '/var/lib/clerum/state/state.db')
  assert.match(value.catalogHash || '', HASH)
  for (const table of ['sessions', 'messages', 'pending_approvals']) {
    assert.match(value.tableHashes?.[table] || '', HASH)
    assert.ok(Number.isSafeInteger(value.counts?.[table]) && value.counts[table] >= 0)
    assert.ok(Array.isArray(value.ids?.[table]) && value.ids[table].length === value.counts[table])
    assert.equal(new Set(value.ids[table]).size, value.ids[table].length)
    assert.equal(value.rowHashes?.[table]?.length, value.ids[table].length)
    for (const row of value.rowHashes[table]) assert.match(row.sha256 || '', HASH)
  }
  if (canonical) {
    assert.equal(value.identity?.hostUid, binding.hostUid)
    assert.equal(value.identity?.pvcUid, binding.pvcUid)
    assert.equal(value.identity?.layoutVersion, 1)
    assert.match(value.identity?.storeId || '', UUID)
  } else { assert.equal(value.identity, null, 'legacy floor must have no canonical identity') }
  return value
}
export function assertCatalogUnchanged(before, after, allowIdentityCreation = false) {
  assert.equal(after.catalogHash, before.catalogHash, 'complete business catalog changed across a read-only transition')
  assert.deepEqual(after.tableHashes, before.tableHashes)
  assert.deepEqual(after.ids, before.ids, 'persisted business IDs changed')
  assert.deepEqual(after.rowHashes, before.rowHashes, 'a business field changed')
  if (!allowIdentityCreation) assert.deepEqual(after.identity, before.identity, 'store identity changed')
}
export function assertPostWrite(before, after) {
  assert.notEqual(after.catalogHash, before.catalogHash, 'a new accepted message must change the durable catalog')
  assert.ok(after.counts.messages > before.counts.messages)
  for (const table of ['sessions', 'messages', 'pending_approvals']) {
    for (const id of before.ids[table]) assert.ok(after.ids[table].includes(id), `lost ${table} ID`)
  }
  // Existing message rows are immutable. Session counters/state may legitimately
  // change after the new turn, so compare their complete rows only at cutover.
  for (const row of before.rowHashes.messages) {
    assert.deepEqual(after.rowHashes.messages.find(candidate => candidate.id === row.id), row)
  }
  assert.deepEqual(after.identity, before.identity)
}
export function assertLiveHold(record, expectedId, now = Date.now()) {
  assert.equal(record.id, expectedId)
  assert.equal(record.state, 'held')
  assert.ok(Number.isSafeInteger(record.deadlineAtMs) && record.deadlineAtMs > now)
  assert.ok(Number.isSafeInteger(record.cut) && record.cut > 0)
}
export function assertHeldRuntime(before, after) {
  for (const key of ['hostUid', 'pvcUid', 'podUid', 'templateHash', 'storeId', 'migrationId']) {
    assert.equal(after[key], before[key], `live hold changed ${key}`)
  }
  assert.equal(after.writerPods, 1)
}
export function assertRollout(before, after, expectedStateless) {
  assert.equal(after.hostUid, before.hostUid)
  assert.equal(after.pvcUid, before.pvcUid)
  assert.equal(after.storeId, before.storeId)
  assert.equal(after.migrationId, before.migrationId)
  assert.equal(after.stateless, expectedStateless)
  assert.equal(after.writerPods, 1)
  assert.notEqual(after.templateHash, before.templateHash, 'confirmed mode transition did not change the template')
  assert.notEqual(after.podUid, before.podUid, 'confirmed mode transition did not replace the Pod')
}
export function validateBarrierDirectory(directory, runId) {
  assert.match(runId || '', UUID)
  const resolved = fs.realpathSync(directory)
  const info = fs.lstatSync(directory)
  assert.ok(info.isDirectory() && !info.isSymbolicLink())
  assert.equal(info.mode & 0o777, 0o700)
  const binding = readCanonicalStoreRecord(path.join(resolved, 'binding.json'))
  assert.equal(binding.runId, runId)
  return resolved
}
export function readBoundRecord(filename, expected) {
  const record = readCanonicalStoreRecord(filename)
  for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value)
  return record
}

export function projectRuntime({ host, deployment, replicasets, pods, pvc }, allowUnready = false) {
  assert.equal(deployment.metadata?.ownerReferences?.find(owner => owner.controller === true)?.uid, host.metadata.uid)
  assert.equal(pvc.metadata.uid, host.status?.conversationStore?.compatibility?.pvcUid)
  const ownedReplicaSets = new Set(replicasets.items.filter(replicaSet =>
    replicaSet.metadata?.ownerReferences?.some(owner => owner.controller === true && owner.uid === deployment.metadata.uid)
  ).map(replicaSet => replicaSet.metadata.uid))
  const writers = pods.items.filter(pod => ownedReplicaSets.has(
    pod.metadata?.ownerReferences?.find(owner => owner.controller === true)?.uid
  ) && pod.status?.containerStatuses?.some(container => container.name === 'mcp-host' && container.state?.running))
  assert.equal(writers.length, 1, 'exactly one current running runtime container')
  const pod = writers[0]
  assert.ok(!pod.metadata.deletionTimestamp, 'current writer is terminating')
  if (!allowUnready) assert.ok(pod.status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'))
  const main = deployment.spec.template.spec.containers.find(container => container.name === 'mcp-host')
  assert.ok(main)
  const values = Object.fromEntries((main.env || []).filter(entry => typeof entry.value === 'string').map(entry => [entry.name, entry.value]))
  const volume = deployment.spec.template.spec.volumes.find(entry => entry.persistentVolumeClaim?.claimName === pvc.metadata.name)
  assert.ok(volume)
  assert.ok(main.volumeMounts?.some(mount => mount.name === volume.name && mount.mountPath === '/workspace' && mount.subPath === 'workspace'))
  assert.ok(main.volumeMounts?.some(mount => mount.name === volume.name && mount.mountPath === '/var/lib/clerum/state' && mount.subPath === 'state'))
  assert.equal(values.CLERUM_SESSION_DB_DIR, '/var/lib/clerum/state')
  assert.equal(values.CLERUM_HOST_UID, host.metadata.uid)
  assert.equal(values.CLERUM_PVC_UID, pvc.metadata.uid)
  assert.ok(['canonical', 'legacy-floor'].includes(values.CLERUM_CANONICAL_STORE_CONTRACT))
  assert.equal(values.CLERUM_CANONICAL_STORE_REQUIRED, values.CLERUM_CANONICAL_STORE_CONTRACT === 'canonical' ? 'true' : 'false')
  assert.equal(deployment.spec.strategy?.type, 'Recreate')
  const store = host.status.conversationStore
  return {
    hostUid: host.metadata.uid, pvcUid: pvc.metadata.uid, podUid: pod.metadata.uid,
    podName: pod.metadata.name, deploymentUid: deployment.metadata.uid,
    replicaSetUid: pod.metadata.ownerReferences.find(owner => owner.controller === true).uid,
    templateHash: digest(deployment.spec.template), writerPods: writers.length,
    image: main.image, imageId: pod.status.containerStatuses.find(container => container.name === 'mcp-host').imageID,
    stateless: values.CLERUM_STATELESS_LIFECYCLE === 'true',
    storageContract: values.CLERUM_CANONICAL_STORE_CONTRACT,
    storeId: store.layout?.storeId || null,
    migrationId: store.operationOutcome?.migrationId || store.compatibility?.migrationId || null,
    requestedStateless: host.spec?.lifecycle?.stateless === true,
    desktopHost: host.spec?.desktop === true,
  }
}
async function observeWatches(context, namespace, deployment, since, durationSeconds) {
  assert.match(context, /^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/)
  assert.match(durationSeconds || '', /^[1-9][0-9]*$/)
  const durationMs = Number(durationSeconds) * 1000
  assert.ok(durationMs <= 1800000)
  const child = spawn('kubectl', ['--context', context, '--request-timeout=30m', 'logs', '-f',
    'deployment/' + deployment, '-n', namespace, '--since-time=' + since], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buffer = ''
  // Allowlisted fixed markers only. No production log payload reaches disk.
  const patterns = [
    /CommunicationChannel watch ended;/,
    /Starting CommunicationChannel watch/,
    /Recovered [0-9]+ CommunicationChannel\(s\) into cache/,
    /McpServer watch ended;/,
    /Context watch ended;/,
    /Starting McpServer watch/,
    /Starting Context watch/,
  ]
  child.stdout.on('data', chunk => {
    buffer += chunk.toString()
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      for (const pattern of patterns) {
        const match = pattern.exec(line)
        if (match) process.stdout.write(match[0] + '\n')
      }
    }
    if (buffer.length > 1048576) { child.kill('SIGTERM'); throw new Error('watch log line exceeds evidence budget') }
  })
  let stopping = false
  const stop = () => { stopping = true; child.kill('SIGTERM') }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const timer = setTimeout(stop, durationMs)
  const killTimer = setTimeout(() => child.kill('SIGKILL'), durationMs + 5000)
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer)
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
      if (stopping) resolve()
      else reject(new Error('live watch observer exited before the gate completed: ' + String(code || signal)))
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (command === 'snapshot') process.stdout.write(JSON.stringify(projectRuntime(JSON.parse(fs.readFileSync(0, 'utf8')), args[0] === 'allow-unready')) + '\n')
  else if (command === 'watch-observer') await observeWatches(...args)
  else if (command === 'preparation') validatePreparation(json(args[0]), args[1], args[2])
  else if (command === 'unchanged') assertCatalogUnchanged(json(args[0]), json(args[1]), args[2] === 'identity-created')
  else if (command === 'post-write') assertPostWrite(json(args[0]), json(args[1]))
  else if (command === 'held-runtime') assertHeldRuntime(json(args[0]), json(args[1]))
  else if (command === 'rollout') assertRollout(json(args[0]), json(args[1]), args[2] === 'true')
  else if (command === 'catalog') validateCatalog(json(args[0]), { hostUid: args[1], pvcUid: args[2] }, args[3] === 'canonical')
  else if (command === 'hold') assertLiveHold(json(args[0]), args[1])
  else if (command === 'barrier') validateBarrierDirectory(args[0], args[1])
  else if (command === 'ack') readBoundRecord(args[0], {
    runId: args[1], phase: args[2], sequence: Number(args[3]), uiVerified: true,
  })
  else throw new Error('unknown lifecycle contract command')
}
