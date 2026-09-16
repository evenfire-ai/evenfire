import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseIdentityJournal,
  restoreOwnedFixture,
  runnerPhaseBudgetMs,
} from './prepare-codex-approved-tools.mjs'

const run = 'approved-tools-123456789abc'
test('identity response must match the durable intent and expected terminal status', () => {
  const expected = {
    version: 1,
    mode: 'deterministic',
    run,
    profile: 'owned',
    context: 'owned',
    users: [{ id: 'user' }],
    team: { id: 'team' },
    grants: { agents: ['agent'] },
    status: 'creation-pending',
  }
  const result = { ...expected, status: 'created' }
  const output = `service startup\n${JSON.stringify({ e2eIdentity: result })}\n`
  assert.deepEqual(parseIdentityJournal(output, expected, 'created'), result)
  for (const changed of [
    { ...result, run: 'foreign' },
    { ...result, users: [] },
    { ...result, status: 'recovery-required' },
    { ...result, extra: 'unexpected' },
  ])
    assert.throws(
      () => parseIdentityJournal(JSON.stringify({ e2eIdentity: changed }), expected, 'created'),
      /does not match/
    )
  assert.throws(() => parseIdentityJournal('no result', expected, 'created'), /does not match/)
})
function fixture() {
  const state = {
    profile: 'test-profile',
    worktree: 'test-worktree',
    head: 'old',
    run,
    proxyUid: 'owned',
    originalProxyImage: 'clerum/codex-llm-proxy:test',
    originalImagePullPolicy: 'IfNotPresent',
    forwards: [{ id: 1 }, { id: 2 }],
    restored: true,
  }
  const deployment = {
    metadata: { uid: 'owned', resourceVersion: '1' },
    spec: {
      template: {
        metadata: { annotations: { 'evenfire.ai/codex-tools-fixture-run': run } },
        spec: {
          containers: [
            { name: 'codex-llm-proxy', image: 'clerum/codex-approved-tools-proxy-e2e:test' },
          ],
        },
      },
    },
  }
  const events = []
  const options = {
    state,
    profile: state.profile,
    worktree: state.worktree,
    head: 'new',
    getDeployment: () => {
      events.push('read')
      return deployment
    },
    patchProxy: value => {
      events.push('patch')
      assert.deepEqual(value.metadata, deployment.metadata)
    },
    waitProxyRollout: () => events.push('ready'),
    cleanupForward: binding => events.push(`cleanup${binding.id}`),
  }
  return { state, deployment, events, options }
}

test('same owned run restores after a commit change and keeps an audit record', async () => {
  const f = fixture()
  await restoreOwnedFixture(f.options)
  assert.equal(f.state.restored, true)
  assert.deepEqual(f.events, ['read', 'patch', 'ready', 'cleanup1', 'cleanup2'])
  assert.deepEqual(f.state.headAudit, { createdHead: 'old', restoredAtHead: 'new' })
})

test('a started identity seed prevents restored success until its cleanup completes', async () => {
  const f = fixture()
  f.state.identitySeedStarted = true
  f.state.identityJournal = { status: 'creation-pending' }
  await assert.rejects(restoreOwnedFixture(f.options), /Identity cleanup adapter is required/)
  assert.equal(f.state.restored, false)
  assert.ok(f.events.includes('cleanup2'))
  await restoreOwnedFixture({
    ...f.options,
    cleanupIdentities: () => {
      f.state.identityJournal.status = 'cleaned'
    },
  })
  assert.equal(f.state.restored, true)
})

for (const mismatch of ['uid', 'run', 'missing-run', 'image']) {
  test(`a ${mismatch} mismatch refuses the proxy write but cleans every owned forward`, async () => {
    const f = fixture()
    if (mismatch === 'uid') f.deployment.metadata.uid = 'foreign'
    if (mismatch === 'run')
      f.deployment.spec.template.metadata.annotations['evenfire.ai/codex-tools-fixture-run'] =
        'approved-tools-aaaaaaaaaaaa'
    if (mismatch === 'missing-run') f.deployment.spec.template.metadata.annotations = {}
    if (mismatch === 'image')
      f.deployment.spec.template.spec.containers[0].image = 'unrelated/image:test'
    await assert.rejects(() => restoreOwnedFixture(f.options))
    assert.equal(f.state.restored, false)
    assert.deepEqual(f.events, ['read', 'cleanup1', 'cleanup2'])
  })
}

test('rollout failure is not restored and does not prevent forward cleanup', async () => {
  const f = fixture()
  f.options.waitProxyRollout = () => {
    f.events.push('ready')
    throw new Error('not-ready')
  }
  await assert.rejects(() => restoreOwnedFixture(f.options), /not-ready/)
  assert.equal(f.state.restored, false)
  assert.deepEqual(f.events, ['read', 'patch', 'ready', 'cleanup1', 'cleanup2'])
})

test('cleanup failure cannot become success and later bindings are still attempted', async () => {
  const f = fixture()
  f.options.cleanupForward = binding => {
    f.events.push(`cleanup${binding.id}`)
    if (binding.id === 1) throw new Error('cleanup-failed')
  }
  await assert.rejects(() => restoreOwnedFixture(f.options), /cleanup-failed/)
  assert.equal(f.state.restored, false)
  assert.deepEqual(f.events.slice(-2), ['cleanup1', 'cleanup2'])
})

test('foreign profile ownership permits no read, patch or cleanup', async () => {
  const f = fixture()
  f.options.profile = 'other'
  await assert.rejects(() => restoreOwnedFixture(f.options), /ownership mismatch/)
  assert.deepEqual(f.events, [])
})

test('the outer deadline contains all runner phases and remains finite', () => {
  const b = runnerPhaseBudgetMs()
  assert(
    b.runnerTimeoutSeconds * 1000 >=
      b.playwright + b.electronCheck + b.staticAudit + b.playwrightSpawnGrace
  )
  assert(b.runnerOuterSpawnTimeoutMs > b.runnerTimeoutSeconds * 1000)
  assert(b.runnerOuterSpawnTimeoutMs < b.maxDeadlineMs)
})
