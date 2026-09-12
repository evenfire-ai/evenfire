import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { restorePatch, snapshot } from '../e2e/_lib/hcc-watch-config.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const config = join(root, 'scripts/e2e/_lib/hcc-watch-config.mjs')

function deployment(env) {
  return {
    metadata: { uid: 'deployment-uid', resourceVersion: '1' },
    spec: {
      template: {
        spec: { containers: [{ name: 'host-context-controller', env }] },
      },
    },
  }
}

function restoredEnvironment(original, current) {
  const patch = restorePatch(original, current).find(patch => patch.path.endsWith('/env'))
  assert.ok(patch, 'restore must write the environment')
  return patch.value
}

test('config snapshot records public env order but values only for fixture-owned variables', () => {
  const saved = snapshot(
    deployment([
      { name: 'DEPENDENCY_URL', value: 'private-dependency-url' },
      { name: 'KUBECONFIG', value: '/private/kubeconfig' },
      { name: 'AFTER_DEPENDENCY', valueFrom: { secretKeyRef: { name: 'private', key: 'value' } } },
    ])
  )
  assert.deepEqual(saved.envNames, ['DEPENDENCY_URL', 'KUBECONFIG', 'AFTER_DEPENDENCY'])
  assert.deepEqual(saved.env, [{ name: 'KUBECONFIG', value: '/private/kubeconfig' }])
  const serialized = JSON.stringify(saved)
  assert.equal(serialized.includes('private-dependency-url'), false)
  assert.equal(serialized.includes('secretKeyRef'), false)
})

test('restore rebuilds the original dependency order and preserves current unrelated values', () => {
  const initial = deployment([
    { name: 'DEPENDENCY_URL', value: 'initial-url' },
    { name: 'KUBECONFIG', value: '/initial/config' },
      { name: 'AFTER_DEPENDENCY', value: '$(KUBECONFIG)/initial-after' },
    { name: 'CONTEXT_MAPPER_NETPOL_RESYNC_SEC', value: '30' },
  ])
  const saved = snapshot(initial)
  const current = deployment([
    { name: 'DEPENDENCY_URL', value: 'concurrently-edited-url' },
    { name: 'KUBECONFIG', value: '/fixture/config' },
      { name: 'AFTER_DEPENDENCY', value: '$(KUBECONFIG)/concurrently-edited-after' },
    { name: 'CONTEXT_MAPPER_NETPOL_RESYNC_SEC', value: '60' },
    { name: 'CONTEXT_MAPPER_K8S_API_CIDRS', value: '1.2.3.4/32' },
  ])
  const env = restoredEnvironment(saved, current)
  assert.deepEqual(
    env.map(item => item.name),
    ['DEPENDENCY_URL', 'KUBECONFIG', 'AFTER_DEPENDENCY', 'CONTEXT_MAPPER_NETPOL_RESYNC_SEC']
  )
  assert.equal(env[0].value, 'concurrently-edited-url')
  assert.equal(env[2].value, '$(KUBECONFIG)/concurrently-edited-after')
  assert.equal(env[1].value, '/initial/config')
  assert.equal(env[3].value, '30')
})

test('restore removes fixture-only variables that were absent from the original environment', () => {
  const saved = snapshot(deployment([{ name: 'DEPENDENCY_URL', value: 'initial' }]))
  const current = deployment([
    { name: 'DEPENDENCY_URL', value: 'edited' },
    { name: 'KUBECONFIG', value: '/fixture/config' },
    { name: 'CONTEXT_MAPPER_NETPOL_RESYNC_SEC', value: '60' },
    { name: 'CONTEXT_MAPPER_K8S_API_CIDRS', value: '1.2.3.4/32' },
  ])
  assert.deepEqual(restoredEnvironment(saved, current), [{ name: 'DEPENDENCY_URL', value: 'edited' }])
})

test('restore rejects unrelated name additions, removals, reordering and duplicates', () => {
  const saved = snapshot(
    deployment([
      { name: 'FIRST', value: 'one' },
      { name: 'KUBECONFIG', value: '/original' },
      { name: 'SECOND', value: 'two' },
    ])
  )
  const variants = [
    [{ name: 'FIRST', value: 'one' }, { name: 'KUBECONFIG', value: '/fixture' }],
    [
      { name: 'FIRST', value: 'one' },
      { name: 'KUBECONFIG', value: '/fixture' },
      { name: 'SECOND', value: 'two' },
      { name: 'NEW', value: 'three' },
    ],
    [
      { name: 'SECOND', value: 'two' },
      { name: 'KUBECONFIG', value: '/fixture' },
      { name: 'FIRST', value: 'one' },
    ],
    [
      { name: 'FIRST', value: 'one' },
      { name: 'KUBECONFIG', value: '/fixture' },
      { name: 'SECOND', value: 'two' },
      { name: 'SECOND', value: 'duplicate' },
    ],
  ]
  for (const env of variants)
    assert.throws(() => restorePatch(saved, deployment(env)), /environment_(name_conflict|changed)/)
})

test('snapshot rejects duplicate environment names', () => {
  assert.throws(
    () => snapshot(deployment([{ name: 'DUPLICATE', value: 'one' }, { name: 'DUPLICATE', value: 'two' }])),
    /environment_name_conflict/
  )
})

test('restore rejects a malformed snapshot that omits an originally owned variable', () => {
  const saved = snapshot(
    deployment([{ name: 'KUBECONFIG', value: '/original' }, { name: 'DEPENDENCY', value: 'value' }])
  )
  saved.env = []
  assert.throws(
    () => restorePatch(saved, deployment([{ name: 'KUBECONFIG', value: '/fixture' }, { name: 'DEPENDENCY', value: 'value' }])),
    /environment_snapshot_invalid/
  )
})

test('verify CLI rejects a restored environment with reordered names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcc-watch-config-'))
  try {
    const original = deployment([
      { name: 'FIRST', value: 'one' },
      { name: 'KUBECONFIG', value: '/original' },
      { name: 'SECOND', value: 'two' },
    ])
    const snapshotPath = join(directory, 'snapshot.json')
    writeFileSync(snapshotPath, JSON.stringify(snapshot(original)))
    const reordered = deployment([
      { name: 'SECOND', value: 'two' },
      { name: 'KUBECONFIG', value: '/original' },
      { name: 'FIRST', value: 'one' },
    ])
    const result = spawnSync(process.execPath, [config, 'verify', snapshotPath], {
      input: JSON.stringify(reordered),
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /configuration_not_restored/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('verify CLI accepts unchanged names with concurrent unrelated value edits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcc-watch-config-'))
  try {
    const original = deployment([
      { name: 'DEPENDENCY_URL', value: 'initial-url' },
      { name: 'KUBECONFIG', value: '/original' },
      { name: 'AFTER_DEPENDENCY', value: '$(KUBECONFIG)/initial-after' },
    ])
    const snapshotPath = join(directory, 'snapshot.json')
    writeFileSync(snapshotPath, JSON.stringify(snapshot(original)))
    const current = deployment([
      { name: 'DEPENDENCY_URL', value: 'concurrently-edited-url' },
      { name: 'KUBECONFIG', value: '/original' },
      { name: 'AFTER_DEPENDENCY', value: '$(KUBECONFIG)/concurrently-edited-after' },
    ])
    const result = spawnSync(process.execPath, [config, 'verify', snapshotPath], {
      input: JSON.stringify(current),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
