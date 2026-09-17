import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cleanupJournaledFixtureResources,
  createJournaledFixtureResources,
  fixtureDeleteRequest,
  fixtureResourceGetArgs,
  fixtureResourceIdentity,
} from './approved-tools-resource-cleanup.mjs'
import {
  assertResourceRoundTrip,
  makeResources,
  makeScenarios,
  makeWorkflowResources,
  makeWorkflowScenario,
  restoreOwnedFixture,
  validateKubectlArgs,
} from './prepare-codex-approved-tools.mjs'

const run = 'approved-tools-123456789abc'
const profile = 'clerum-fixture-12345678'
const prefix = [`--context=${profile}`, '--request-timeout=30s']
function proposal() {
  const workflow = makeWorkflowScenario(run, 43105, 43104)
  return [
    ...makeResources([...makeScenarios(run, [43101, 43102, 43103], 43104), workflow]),
    ...makeWorkflowResources(workflow),
  ]
}
function returned(resource, index = 1) {
  return {
    ...structuredClone(resource),
    metadata: {
      ...structuredClone(resource.metadata),
      uid: `server-${index}`,
      resourceVersion: String(index),
    },
  }
}
async function journalFor(resources = proposal()) {
  const journal = []
  await createJournaledFixtureResources({
    resources,
    run,
    journal,
    save() {},
    create: resource => returned(resource, journal.length),
  })
  return journal
}

test('real proposal kinds, namespaces, names and exact run labels are accepted and each server identity is saved', async () => {
  const journal = []
  const saves = []
  await createJournaledFixtureResources({
    resources: proposal(),
    run,
    journal,
    save: () => saves.push(structuredClone(journal)),
    create: resource => returned(resource, journal.length),
    validateCreated: assertResourceRoundTrip,
  })
  assert.equal(journal.length, 15)
  assert.equal(saves.length, 30)
  assert.equal(saves[0][0].status, 'creation-pending')
  assert.equal(saves[1][0].metadata.uid, 'server-1')
  assert.equal(saves[1][0].metadata.resourceVersion, '1')
  for (const entry of journal) assert.doesNotThrow(() => fixtureResourceIdentity(entry, run))
})

test('partial create failure retains actual earlier identities and ambiguous intent without name-only cleanup', async () => {
  const journal = []
  await assert.rejects(
    createJournaledFixtureResources({
      resources: proposal(),
      run,
      journal,
      save() {},
      create: resource => {
        if (journal.length === 2) throw new Error('lost response')
        return returned(resource)
      },
    }),
    /lost response/
  )
  assert.equal(journal.length, 2)
  assert.equal(journal[0].metadata.uid, 'server-1')
  assert.equal(journal[1].status, 'creation-pending')
  await assert.rejects(
    cleanupJournaledFixtureResources({
      journal,
      run,
      save() {},
      get: () => assert.fail('ambiguous ownership read'),
      remove: () => assert.fail('name-only delete'),
    }),
    /Unresolved/
  )
})

test('creation field validation fails after identity persistence, permitting ownership cleanup', async () => {
  const journal = []
  await assert.rejects(
    createJournaledFixtureResources({
      resources: proposal(),
      run,
      journal,
      save() {},
      create: resource => returned(resource),
      validateCreated() {
        throw new Error('pruned field')
      },
    }),
    /pruned field/
  )
  assert.equal(journal[0].status, 'created')
  assert.equal(journal[0].metadata.uid, 'server-1')
})

test('deletes dependents first, uses fresh resourceVersion, saves completion and permits absent resources', async () => {
  const journal = await journalFor()
  const removed = new Set()
  const order = []
  await cleanupJournaledFixtureResources({
    journal,
    run,
    save() {},
    get: entry =>
      removed.has(entry.metadata.uid) || entry.metadata.uid === 'server-1'
        ? null
        : { ...entry, metadata: { ...entry.metadata, resourceVersion: '999' } },
    remove: request => {
      assert.equal(request.body.preconditions.resourceVersion, '999')
      assert.equal(request.body.propagationPolicy, 'Foreground')
      const entry = journal.find(item => item.metadata.uid === request.body.preconditions.uid)
      order.push(entry.kind)
      removed.add(entry.metadata.uid)
    },
  })
  assert.equal(order[0], 'WorkflowRecipe')
  assert(order.lastIndexOf('Host') < order.indexOf('McpServer'))
  assert(order.lastIndexOf('McpServer') < order.indexOf('Context'))
  assert(order.lastIndexOf('Context') < order.indexOf('NetworkPolicy'))
  assert(journal.every(entry => entry.status === 'deleted'))
})

for (const mutation of ['uid', 'run', 'suite', 'namespace', 'name', 'kind', 'apiVersion']) {
  test(`changed ${mutation} prevents deletion`, async () => {
    const journal = await journalFor(proposal().slice(0, 1))
    const live = structuredClone(journal[0])
    if (mutation === 'run')
      live.metadata.labels['evenfire.ai/e2e-run'] = 'approved-tools-aaaaaaaaaaaa-83'
    else if (mutation === 'suite') live.metadata.labels['evenfire.ai/e2e-suite'] = 'foreign'
    else if (['kind', 'apiVersion'].includes(mutation)) live[mutation] = 'foreign'
    else live.metadata[mutation] = 'foreign'
    await assert.rejects(
      cleanupJournaledFixtureResources({
        journal,
        run,
        save() {},
        get: () => live,
        remove: () => assert.fail('foreign delete'),
      })
    )
    assert.equal(journal[0].status, 'created')
  })
}

test('delete conflict and replacement while waiting preserve journal and stop dependency deletion', async () => {
  for (const conflict of [true, false]) {
    const journal = await journalFor()
    let deletes = 0
    await assert.rejects(
      cleanupJournaledFixtureResources({
        journal,
        run,
        save() {},
        get: entry => entry,
        remove() {
          deletes++
          if (conflict) throw new Error('Conflict')
        },
        waitForDeletion: entry => returned(entry, 999),
      })
    )
    assert.equal(deletes, 1)
    assert(journal.every(entry => entry.status === 'created'))
  }
})

test('read errors and legacy name-only journals fail closed', async () => {
  for (const journal of [
    await journalFor(),
    [{ kind: 'Host', name: `${run}-agent-83`, namespace: 'mcp-host' }],
  ]) {
    await assert.rejects(
      cleanupJournaledFixtureResources({
        journal,
        run,
        save() {},
        get() {
          throw new Error('transport')
        },
        remove: () => assert.fail('delete'),
      })
    )
  }
})

test('allowlist binds exact namespace, kind, generated name and both preconditions to checked resource', async () => {
  const [entry] = await journalFor()
  const live = { ...entry, metadata: { ...entry.metadata, resourceVersion: '200' } }
  const request = fixtureDeleteRequest(entry, live, run)
  const args = [...prefix, 'delete', '--raw', request.path, '-f', '-']
  const options = { resourceCleanup: { entry, live, run }, input: JSON.stringify(request.body) }
  assert.doesNotThrow(() => validateKubectlArgs(args, profile, options))
  assert.doesNotThrow(() =>
    validateKubectlArgs([...prefix, ...fixtureResourceGetArgs(entry, run)], profile, {
      resourceCleanup: { entry, run },
    })
  )
  assert.throws(() => validateKubectlArgs(args, profile))
  for (const field of ['uid', 'resourceVersion']) {
    const body = structuredClone(request.body)
    delete body.preconditions[field]
    assert.throws(() =>
      validateKubectlArgs(args, profile, { ...options, input: JSON.stringify(body) })
    )
  }
  for (const uri of [
    '/api/v1/namespaces/default',
    request.path.replace('/mcp-server/', '/mcp-host/'),
    request.path.replace('/contexts/', '/hosts/'),
    request.path.replace(run, 'approved-tools-aaaaaaaaaaaa'),
  ])
    assert.throws(() =>
      validateKubectlArgs([...prefix, 'delete', '--raw', uri, '-f', '-'], profile, options)
    )
  assert.throws(() =>
    validateKubectlArgs([...prefix, 'delete', '--all', 'hosts'], profile, options)
  )
})

test('resource cleanup failure leaves restored false after proxy and forward cleanup', async () => {
  const events = []
  const state = {
    profile,
    worktree: 'owned',
    head: 'head',
    run,
    proxyUid: 'proxy',
    originalProxyImage: 'original',
    forwards: [1],
    resources: await journalFor(),
  }
  await assert.rejects(
    restoreOwnedFixture({
      state,
      profile,
      worktree: 'owned',
      head: 'head',
      getDeployment: () => ({
        metadata: { uid: 'proxy' },
        spec: {
          template: { spec: { containers: [{ name: 'codex-llm-proxy', image: 'original' }] } },
        },
      }),
      patchProxy() {
        assert.fail('patch')
      },
      waitProxyRollout: () => events.push('proxy'),
      cleanupForward: () => events.push('forward'),
      cleanupResources() {
        events.push('resources')
        throw new Error('resource conflict')
      },
    }),
    /resource conflict/
  )
  assert.deepEqual(events, ['proxy', 'forward', 'resources'])
  assert.equal(state.restored, false)
})
