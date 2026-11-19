import { afterEach, describe, expect, it } from 'vitest'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from '../src/services/access/accessExecutionBudget.js'
import { selectActionOperationalDependencies } from '../src/services/access/liveAuthorizationResolver.js'
import {
  OperationalProjectionError,
  canonicalEnvironmentId,
} from '../src/services/access/operationalAccessProjection.js'
import {
  type OperationalGraphClass,
  type OperationalResourceGraphResult,
  loadLiveOperationalResourceGraph,
} from '../src/services/access/operationalAccessReader.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { K8sNotFoundError } from '../src/services/resourceService.js'
import {
  type FakeGatewayCall,
  OPERATIONAL_NAMESPACES,
  contextObject,
  createFakeOperationalGateway,
  hostObject,
  mcpServerObject,
  sharedFilesystemObject,
} from './helpers/fakeOperationalGateway.js'

const environmentId = canonicalEnvironmentId()
const ctx = (name: string) => `${OPERATIONAL_NAMESPACES.contexts}/${name}`
const host = (name: string) => `${OPERATIONAL_NAMESPACES.hosts}/${name}`
const mcp = (name: string) => `${OPERATIONAL_NAMESPACES.mcpservers}/${name}`

const budgets: AccessExecutionBudget[] = []
function newBudget(): AccessExecutionBudget {
  const budget = AccessExecutionBudget.create('action')
  budgets.push(budget)
  return budget
}
afterEach(() => {
  for (const budget of budgets.splice(0)) budget.close()
})

function statusError(status: number, message = `http ${status}`): Error {
  return Object.assign(new Error(message), { statusCode: status, code: status })
}

function baseObjects() {
  return {
    hosts: [
      hostObject('host-a', { contextRef: 'ctx-a' }),
      hostObject('host-b', { contextRef: 'ctx-b' }),
    ],
    contexts: [
      contextObject('ctx-a', { mcpServers: ['weather'], sharedFileSystems: ['docs'] }),
      contextObject('ctx-b', { mcpServers: ['weather'] }),
    ],
    mcpservers: [mcpServerObject('weather', { contextRef: 'ctx-b' })],
    sharedfilesystems: [sharedFilesystemObject('docs')],
  }
}

async function load(input: {
  gateway: ReturnType<typeof createFakeOperationalGateway>['gateway']
  type: 'host' | 'context' | 'mcp_server'
  logicalId: string
  operationClass?: OperationalGraphClass
  budget?: AccessExecutionBudget
}): Promise<OperationalResourceGraphResult> {
  return loadLiveOperationalResourceGraph({
    gateway: input.gateway,
    budget: input.budget ?? newBudget(),
    resource: canonicalResourceIdentity({
      environmentId,
      type: input.type,
      logicalId: input.logicalId,
    }),
    operationClass: input.operationClass ?? 'full',
  })
}

function calledLists(calls: readonly FakeGatewayCall[]): string[] {
  return calls
    .filter(call => call.method === 'listResourcePage')
    .map(call => `${call.plural}${call.continueToken ? `@${call.continueToken}` : ''}`)
}

describe('live loader fail-closed table (merge plan v2 §2.5, T-L3)', () => {
  it.each([
    ['a 5xx', statusError(503)],
    ['a 403', statusError(403)],
    ['a 404 (namespace or CRD absent)', new K8sNotFoundError('contexts not found')],
    ['a network error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['a timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
  ])('throws on %s from a LIST instead of reading it as no objects', async (_label, failure) => {
    const fake = createFakeOperationalGateway({
      objects: baseObjects(),
      fail: call => (call.method === 'listResourcePage' ? failure : undefined),
    })
    await expect(
      load({ gateway: fake.gateway, type: 'host', logicalId: host('host-a') })
    ).rejects.toBe(failure)
    // Witness: the failing LIST was issued.
    expect(calledLists(fake.calls)).toContain('contexts')
  })

  it('throws on 410 Gone for a continue token and returns no graph', async () => {
    const gone = statusError(410, 'Expired')
    const many = Array.from({ length: 150 }, (_, index) => contextObject(`ctx-${index}`))
    const fake = createFakeOperationalGateway({
      objects: { contexts: many },
      fail: call =>
        call.method === 'listResourcePage' && call.continueToken !== undefined ? gone : undefined,
    })
    await expect(
      load({ gateway: fake.gateway, type: 'context', logicalId: ctx('ctx-1') })
    ).rejects.toBe(gone)
    expect(calledLists(fake.calls)).toEqual(['contexts', 'contexts@contexts:100'])
  })

  it('answers not_found only for a root GET 404', async () => {
    const fake = createFakeOperationalGateway({ objects: baseObjects() })
    await expect(
      load({ gateway: fake.gateway, type: 'host', logicalId: host('missing') })
    ).resolves.toEqual({ status: 'not_found' })
    expect(
      fake.calls.some(call => call.method === 'getResourceExact' && call.name === 'missing')
    ).toBe(true)
  })

  it('throws on any other root GET error', async () => {
    const failure = statusError(500)
    const fake = createFakeOperationalGateway({
      objects: baseObjects(),
      fail: call => (call.method === 'getResourceExact' ? failure : undefined),
    })
    await expect(
      load({ gateway: fake.gateway, type: 'host', logicalId: host('host-a') })
    ).rejects.toBe(failure)
    expect(fake.calls.some(call => call.method === 'getResourceExact')).toBe(true)
  })

  it.each([
    ['disabled', hostObject('host-z', { enabled: false, contextRef: 'ctx-a' })],
    [
      'being deleted',
      hostObject('host-z', { contextRef: 'ctx-a' }, { deletionTimestamp: '2026-11-09T00:00:00Z' }),
    ],
  ])('answers not_found for a %s root', async (_label, object) => {
    const objects = baseObjects()
    const fake = createFakeOperationalGateway({
      objects: { ...objects, hosts: [...objects.hosts, object] },
    })
    await expect(
      load({ gateway: fake.gateway, type: 'host', logicalId: host('host-z') })
    ).resolves.toEqual({ status: 'not_found' })
    expect(
      fake.calls.some(call => call.method === 'getResourceExact' && call.name === 'host-z')
    ).toBe(true)
  })

  it('throws when any object of a LIST page fails projection', async () => {
    const objects = baseObjects()
    const fake = createFakeOperationalGateway({
      objects: { ...objects, contexts: [...objects.contexts, { metadata: { name: 'broken' } }] },
    })
    await expect(
      load({ gateway: fake.gateway, type: 'host', logicalId: host('host-a') })
    ).rejects.toBeInstanceOf(OperationalProjectionError)
    expect(calledLists(fake.calls)).toContain('contexts')
  })

  it.each([
    ['no Context', [contextObject('ctx-b')]],
    [
      'two Contexts',
      [
        contextObject('ctx-x', { contextId: 'ctx-a' }),
        contextObject('ctx-y', { contextId: 'ctx-a' }),
      ],
    ],
  ])(
    'answers unavailable when the Host Context reference resolves to %s',
    async (_label, contexts) => {
      const objects = baseObjects()
      const fake = createFakeOperationalGateway({ objects: { ...objects, contexts } })
      await expect(
        load({ gateway: fake.gateway, type: 'host', logicalId: host('host-a') })
      ).resolves.toEqual({ status: 'unavailable', safeCode: 'operational_source_unavailable' })
      expect(calledLists(fake.calls)).toEqual(['contexts'])
    }
  )

  it('answers unavailable for another unresolved uses_context target', async () => {
    const objects = baseObjects()
    const fake = createFakeOperationalGateway({
      objects: {
        ...objects,
        mcpservers: [mcpServerObject('weather', { contextRef: 'gone' })],
      },
    })
    await expect(
      load({ gateway: fake.gateway, type: 'mcp_server', logicalId: mcp('weather') })
    ).resolves.toEqual({
      status: 'unavailable',
      safeCode: 'operational_related_resource_incomplete',
    })
    expect(calledLists(fake.calls)).toEqual(['contexts', 'hosts'])
  })

  it('answers unavailable when a related resource is missing (full)', async () => {
    const objects = baseObjects()
    const fake = createFakeOperationalGateway({ objects: { ...objects, sharedfilesystems: [] } })
    await expect(
      load({ gateway: fake.gateway, type: 'host', logicalId: host('host-a') })
    ).resolves.toEqual({
      status: 'unavailable',
      safeCode: 'operational_related_resource_incomplete',
    })
    expect(calledLists(fake.calls).sort()).toEqual(['contexts', 'mcpservers', 'sharedfilesystems'])
  })

  it('answers unavailable when a resource is missing after host-graph selection', async () => {
    const objects = baseObjects()
    const fake = createFakeOperationalGateway({ objects: { ...objects, sharedfilesystems: [] } })
    const graph = await load({
      gateway: fake.gateway,
      type: 'host',
      logicalId: host('host-a'),
      operationClass: 'host_graph',
    })
    expect(graph.status).toBe('current')
    // host_graph never lists MCP servers; the shared filesystem is still read.
    expect(calledLists(fake.calls).sort()).toEqual(['contexts', 'sharedfilesystems'])
    expect(
      selectActionOperationalDependencies(graph, 'host.status.read', { hostRef: host('host-a') })
    ).toEqual({ status: 'unavailable', safeCode: 'operational_related_resource_incomplete' })
  })

  it('throws AccessExecutionCancelledError when the budget is cancelled mid-read', async () => {
    const budget = newBudget()
    const fake = createFakeOperationalGateway({
      objects: baseObjects(),
      fail: call => {
        if (call.method === 'listResourcePage') budget.cancel()
        return undefined
      },
    })
    await expect(
      load({ gateway: fake.gateway, type: 'context', logicalId: ctx('ctx-a'), budget })
    ).rejects.toBeInstanceOf(AccessExecutionCancelledError)
    expect(calledLists(fake.calls)).toEqual(['contexts'])
  })

  it('reads only the families the root needs (merge plan v2 §2.3)', async () => {
    const fake = createFakeOperationalGateway({ objects: baseObjects() })
    const graph = await load({
      gateway: fake.gateway,
      type: 'mcp_server',
      logicalId: mcp('weather'),
    })
    expect(graph.status).toBe('current')
    expect(fake.calls.map(call => `${call.method}:${call.plural}`).sort()).toEqual([
      'getResourceExact:mcpservers',
      'listResourcePage:contexts',
      'listResourcePage:hosts',
    ])
    for (const call of fake.calls) {
      expect(call.namespace).toBe(OPERATIONAL_NAMESPACES[call.plural])
      expect(call.timeoutSeconds).toBeGreaterThanOrEqual(1)
      expect(call.timeoutSeconds).toBeLessThanOrEqual(60)
    }
  })
})

describe('live loader paging (T-L4)', () => {
  it('follows continue tokens until the collection is complete', async () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      contextObject(`ctx-${String(index).padStart(3, '0')}`)
    )
    const fake = createFakeOperationalGateway({ objects: { contexts: many } })
    const budget = newBudget()
    const producerCallsBefore = budget.remaining('producerCalls')
    const graph = await load({
      gateway: fake.gateway,
      type: 'context',
      logicalId: ctx('ctx-249'),
      budget,
    })
    expect(graph.status).toBe('current')
    expect(calledLists(fake.calls)).toEqual([
      'contexts',
      'contexts@contexts:100',
      'contexts@contexts:200',
    ])
    expect(fake.calls.every(call => call.limit === 100)).toBe(true)
    expect(producerCallsBefore - budget.remaining('producerCalls')).toBe(3)
    expect(budget.remaining('objects')).toBe(1_000 - 250)
  })

  it('returns no graph when a later page rejects', async () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      contextObject(`ctx-${String(index).padStart(3, '0')}`)
    )
    const failure = statusError(503)
    const fake = createFakeOperationalGateway({
      objects: { contexts: many },
      fail: call => (call.continueToken === 'contexts:100' ? failure : undefined),
    })
    await expect(
      load({ gateway: fake.gateway, type: 'context', logicalId: ctx('ctx-000') })
    ).rejects.toBe(failure)
    expect(calledLists(fake.calls)).toEqual(['contexts', 'contexts@contexts:100'])
  })
})

describe('live loader budget charges (T-L5)', () => {
  it('rejects the 1,001st object', async () => {
    const many = Array.from({ length: 1_001 }, (_, index) => contextObject(`ctx-${index}`))
    const fake = createFakeOperationalGateway({ objects: { contexts: many } })
    const budget = newBudget()
    const error = await load({
      gateway: fake.gateway,
      type: 'context',
      logicalId: ctx('ctx-0'),
      budget,
    }).catch(caught => caught)
    expect(error).toBeInstanceOf(AccessBudgetExceededError)
    expect(error.limit).toBe('objects')
    // Witness: every one of the first 1,000 objects was charged.
    expect(budget.remaining('objects')).toBe(0)
  })

  it('rejects one object over 512 KB', async () => {
    const huge = contextObject('ctx-huge', {}, { padBytes: 513 * 1024 })
    const fake = createFakeOperationalGateway({
      objects: { contexts: [contextObject('ctx-a'), huge] },
    })
    const budget = newBudget()
    const error = await load({
      gateway: fake.gateway,
      type: 'context',
      logicalId: ctx('ctx-a'),
      budget,
    }).catch(caught => caught)
    expect(error).toBeInstanceOf(AccessBudgetExceededError)
    expect(error.limit).toBe('objectBytes')
    // Witness: the object before it was charged.
    expect(budget.remaining('objects')).toBe(999)
  })

  it('charges each object read and each relationship of the built graph', async () => {
    const fake = createFakeOperationalGateway({ objects: baseObjects() })
    const budget = newBudget()
    const graph = await load({
      gateway: fake.gateway,
      type: 'host',
      logicalId: host('host-a'),
      budget,
    })
    expect(graph.status).toBe('current')
    if (graph.status !== 'current') return
    // host-a GET, ctx-a and ctx-b LIST, weather LIST, docs LIST.
    expect(budget.remaining('objects')).toBe(1_000 - 5)
    expect(budget.remaining('relationships')).toBe(4_096 - graph.relationships.length)
    expect(graph.relationships.length).toBe(3)
    expect(budget.remaining('producerCalls')).toBe(32 - 4)
  })
})
