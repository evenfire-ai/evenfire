import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { CREATE_KINDS, createsTotal, existenceReadsTotal, registry } from './metrics'
import { applyNetworkPolicy, observeExistenceRead } from './utils'

async function count(kind: string, outcome: string): Promise<number> {
  const sample = (await existenceReadsTotal.get()).values.find(
    value => value.labels.kind === kind && value.labels.outcome === outcome
  )
  expect(sample).toBeDefined()
  return sample!.value
}

it('initializes the real read registry before any test seeding', async () => {
  expect(registry.getSingleMetric('clerum_hcc_existence_reads_total')).toBe(existenceReadsTotal)
  const snapshot = await existenceReadsTotal.get()
  expect(snapshot.values).toHaveLength(CREATE_KINDS.length * 3)
  for (const kind of CREATE_KINDS) {
    for (const outcome of ['found', 'absent', 'error']) expect(await count(kind, outcome)).toBe(0)
  }
  for (const sample of snapshot.values)
    expect(Object.keys(sample.labels).sort()).toEqual(['kind', 'outcome'])
})

// Review each exclusion when its enclosing operation changes. Counts describe
// expressions, not executions; a newly added direct read must be classified.
const readExclusions: Record<string, readonly [number, string]> = {
  'hostReconciler.ts::readHostDeploymentOrNull::readNamespacedDeployment': [
    1,
    'Input to runtime binding and refresh decisions',
  ],
  'hostReconciler.ts::refreshCodexSnapshot::readNamespacedConfigMap': [
    1,
    'Input allowlist snapshot',
  ],
  'hostReconciler.ts::deleteHostRbac::readNamespacedRoleBinding': [1, 'Ownership before deletion'],
  'hostReconciler.ts::deleteHostRbac::readNamespacedRole': [1, 'Ownership before deletion'],
  'hostReconciler.ts::deleteHostRbac::readNamespacedServiceAccount': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteMcpHostRuntimeTokenSecret::readNamespacedSecret': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteLegacyChannelReaderRuntimeAuth::readNamespacedSecret': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::validateHostSecret::readNamespacedSecret': [1, 'Input validation'],
  'hostReconciler.ts::computeChannelReaderRevisionForHost::readNamespacedSecret': [
    1,
    'Input to desired revision',
  ],
  'hostReconciler.ts::checkDeploymentReady::readNamespacedDeployment': [1, 'Readiness observation'],
  'hostReconciler.ts::checkChannelReaderStatus::readNamespacedDeployment': [
    1,
    'Status observation',
  ],
  'hostReconciler.ts::deleteRuntimeResources::readNamespacedDeployment': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteRuntimeResources::readNamespacedService': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteRuntimeResources::readNamespacedNetworkPolicy': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteWorkspacePvc::readNamespacedPersistentVolumeClaim': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteChannelReaderDeployment::readNamespacedDeployment': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteChannelReaderService::readNamespacedService': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteMcpHostCodexProxyEgressNetworkPolicy::readNamespacedNetworkPolicy': [
    1,
    'Ownership before deletion',
  ],
  'hostReconciler.ts::deleteHostNetworkPolicies::readNamespacedNetworkPolicy': [
    1,
    'Ownership before deletion',
  ],
  'k8sClient.ts::readSecretMetadata::readNamespacedSecret': [1, 'Authorization input metadata'],
  'k8sClient.ts::readSecret::readNamespacedSecret': [1, 'Authorization input data'],
  'llmHookReconciler.ts::validateSecret::readNamespacedSecret': [1, 'Input validation'],
  'llmHookReconciler.ts::deleteServiceTargetNetworkPolicy::readNamespacedNetworkPolicy': [
    1,
    'Ownership before deletion',
  ],
  'llmHookReconciler.ts::readServiceSelector::readNamespacedService': [
    1,
    'Input selector for another resource',
  ],
  'llmHookReconciler.ts::deleteHostEgressNetworkPolicy::readNamespacedNetworkPolicy': [
    1,
    'Ownership before deletion',
  ],
  'llmHookReconciler.ts::gcPodKey::readNamespacedDeployment': [
    1,
    'Ownership before garbage collection',
  ],
  'llmHookReconciler.ts::gcPodKey::readNamespacedService': [
    1,
    'Ownership before garbage collection',
  ],
  'llmHookReconciler.ts::gcPodKey::readNamespacedNetworkPolicy': [
    1,
    'Ownership before garbage collection',
  ],
  'llmHookReconciler.ts::readDeploymentRollout::readNamespacedDeployment': [
    1,
    'Readiness observation',
  ],
  'networkPolicyReconciler.ts::judgeLiveExactHostEgress::readNamespacedNetworkPolicy': [
    1,
    'Retain or revoke verdict after failure',
  ],
  'networkPolicyReconciler.ts::replaceSafetyPolicySnapshot::readNamespacedNetworkPolicy': [
    1,
    'Identity check for replace-only safety path',
  ],
  'networkPolicyReconciler.ts::deleteLegacyStaticPolicy::readNamespacedNetworkPolicy': [
    1,
    'Ownership before deletion',
  ],
  'reconciler.ts::readDeploymentRollout::readNamespacedDeployment': [1, 'Readiness observation'],
  'reconciler.ts::validateSecret::readNamespacedSecret': [1, 'Input validation'],
  'reconciler.ts::deleteDeploymentIfHccOwned::readNamespacedDeployment': [
    1,
    'Ownership before deletion',
  ],
  'reconciler.ts::deleteConfigMapIfHccOwned::readNamespacedConfigMap': [
    1,
    'Ownership before deletion',
  ],
  'reconciler.ts::deleteServiceIfHccOwned::readNamespacedService': [1, 'Ownership before deletion'],
  'sharedFileSystemReconciler.ts::assessReadiness::readNamespacedPersistentVolumeClaim': [
    1,
    'Readiness observation',
  ],
  'sharedFileSystemReconciler.ts::assessReadiness::readNamespacedDeployment': [
    1,
    'Readiness observation',
  ],
  'statelessLifecycleExecutor.ts::handleWakeFastPath::readNamespacedDeployment': [
    1,
    'Scale-only compatibility path',
  ],
  'k8s/gfsK8sApi.ts::scaleDeployment::readNamespacedDeployment': [
    2,
    'Scale-only initial and retry reads',
  ],
  'k8s/gfsK8sApi.ts::isDeploymentAvailable::readNamespacedDeployment': [1, 'Readiness observation'],
}

function readProductionSources(): Record<string, string> {
  const sources: Record<string, string> = {}
  for (const relative of readdirSync(__dirname, { recursive: true }) as string[]) {
    if (
      !relative.endsWith('.ts') ||
      relative.endsWith('.test.ts') ||
      relative.includes('__tests__')
    )
      continue
    sources[relative] = readFileSync(join(__dirname, relative), 'utf8')
  }
  return sources
}

function assertReadInventory(sources: Record<string, string>): void {
  const expectedWrapped: Record<string, number> = {
    'utils.ts': 1,
    'hostReconciler.ts': 8,
    'reconciler.ts': 3,
    'llmHookReconciler.ts': 3,
    'sharedFileSystemReconciler.ts': 1,
    'k8s/gfsK8sApi.ts': 5,
    'networkPolicyReconciler.ts': 2,
  }
  const wrapped: Record<string, number> = {}
  const excluded: Record<string, number> = {}
  for (const [path, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'observeExistenceRead'
      ) {
        wrapped[path] = (wrapped[path] ?? 0) + 1
        expect(node.arguments).toHaveLength(2)
        const [kind, read] = node.arguments
        expect(ts.isStringLiteral(kind), path).toBe(true)
        expect(ts.isArrowFunction(read), path).toBe(true)
        if (ts.isStringLiteral(kind) && ts.isArrowFunction(read)) {
          expect(CREATE_KINDS).toContain(kind.text)
          expect(read.parameters).toHaveLength(0)
          expect(ts.isCallExpression(read.body), path).toBe(true)
          if (
            ts.isCallExpression(read.body) &&
            ts.isPropertyAccessExpression(read.body.expression)
          ) {
            expect(read.body.expression.name.text, path).toBe(`readNamespaced${kind.text}`)
          } else throw new Error(`${path}: wrapper must observe a direct API read`)
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^read(?:Namespaced|Cluster)/.test(node.expression.name.text)
      ) {
        const parent = node.parent
        const isWrapped =
          ts.isArrowFunction(parent) &&
          ts.isCallExpression(parent.parent) &&
          ts.isIdentifier(parent.parent.expression) &&
          parent.parent.expression.text === 'observeExistenceRead'
        if (!isWrapped) {
          let owner: ts.Node | undefined = node.parent
          while (owner && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner))
            owner = owner.parent
          const name =
            owner && (ts.isMethodDeclaration(owner) || ts.isFunctionDeclaration(owner))
              ? owner.name?.getText(source)
              : undefined
          const id = `${path}::${name ?? '<module>'}::${node.expression.name.text}`
          if (!Object.hasOwn(readExclusions, id))
            throw new Error(`Unclassified Kubernetes read: ${id}`)
          excluded[id] = (excluded[id] ?? 0) + 1
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(wrapped).toEqual(expectedWrapped)
  for (const [id, [count, reason]] of Object.entries(readExclusions)) {
    expect(reason.length, id).toBeGreaterThan(0)
    expect(excluded[id], `Stale or changed read exclusion: ${id}`).toBe(count)
  }
  expect(Object.values(wrapped).reduce((sum, count) => sum + count, 0)).toBe(23)
  expect(Object.values(excluded).reduce((sum, count) => sum + count, 0)).toBe(43)
}

it('classifies every direct dot-property production SDK read as observed or explicitly excluded', () => {
  assertReadInventory(readProductionSources())
})

it.each(['utils.ts', 'new-reader.ts'])('rejects an unclassified read introduced in %s', path => {
  const sources = readProductionSources()
  // Synthetic source is parsed only: no client method or network request executes.
  sources[path] =
    (sources[path] ?? '') +
    '\nfunction unclassifiedRead(client) { return client.readNamespacedService({}) }'
  expect(() => assertReadInventory(sources)).toThrow(
    `Unclassified Kubernetes read: ${path}::unclassifiedRead::readNamespacedService`
  )
})

it('rejects an exclusion after its read disappears or moves', () => {
  const sources = readProductionSources()
  delete sources['statelessLifecycleExecutor.ts']
  expect(() => assertReadInventory(sources)).toThrow(
    'Stale or changed read exclusion: statelessLifecycleExecutor.ts::handleWakeFastPath::readNamespacedDeployment'
  )
})

describe('Kubernetes existence-read instrumentation', () => {
  beforeEach(() => {
    existenceReadsTotal.reset()
    createsTotal.reset()
    for (const kind of CREATE_KINDS) {
      for (const outcome of ['found', 'absent', 'error'])
        existenceReadsTotal.inc({ kind, outcome }, 0)
      for (const outcome of ['created', 'conflict', 'error', 'skipped'])
        createsTotal.inc({ kind, outcome }, 0)
    }
  })

  it.each([{ metadata: { uid: 'existing', resourceVersion: '17' } }, null, undefined])(
    'returns the exact resolved value with one read: %j',
    async response => {
      const read = vi.fn().mockResolvedValue(response)
      expect(await observeExistenceRead('Service', read)).toBe(response)
      expect(read).toHaveBeenCalledTimes(1)
      expect(await count('Service', 'found')).toBe(1)
      expect(await count('Service', 'absent')).toBe(0)
      expect(await count('Service', 'error')).toBe(0)
      expect((await createsTotal.get()).values.every(sample => sample.value === 0)).toBe(true)
    }
  )

  // Minimal fixtures pin classification and rejection identity without constructing
  // SDK errors: ApiException.code and getErrorCode's response.statusCode compatibility.
  it.each([
    [{ code: 404 }, 'absent'],
    [{ response: { statusCode: 404 } }, 'absent'],
    [{ code: 403 }, 'error'],
    [{ response: { statusCode: 500 } }, 'error'],
    [{ code: 409 }, 'error'],
    [{ code: 'ECONNRESET' }, 'error'],
    [null, 'error'],
    [undefined, 'error'],
  ] as const)(
    'preserves rejection identity and classifies only 404 as absent: %j',
    async (error, outcome) => {
      const read = vi.fn().mockRejectedValue(error)
      await expect(observeExistenceRead('Service', read)).rejects.toBe(error)
      expect(read).toHaveBeenCalledTimes(1)
      for (const candidate of ['found', 'absent', 'error'])
        expect(await count('Service', candidate)).toBe(candidate === outcome ? 1 : 0)
    }
  )

  it.each([{ code: 404 }, new Error('request construction failed'), null, undefined])(
    'preserves synchronous throws with one attempt: %j',
    async error => {
      const read = vi.fn(() => {
        throw error
      })
      await expect(observeExistenceRead('Deployment', read)).rejects.toBe(error)
      expect(read).toHaveBeenCalledTimes(1)
      expect(await count('Deployment', error && 'code' in error ? 'absent' : 'error')).toBe(1)
    }
  )

  it('preserves existing observations across module re-import', async () => {
    const response = { metadata: { uid: 'observed' } }
    const read = vi.fn().mockResolvedValue(response)
    expect(await observeExistenceRead('Service', read)).toBe(response)
    vi.resetModules()
    const reloaded = await import('./metrics')
    expect(reloaded.registry).toBe(registry)
    expect(reloaded.existenceReadsTotal).toBe(existenceReadsTotal)
    expect(read).toHaveBeenCalledTimes(1)
    expect(await count('Service', 'found')).toBe(1)
    expect(await registry.metrics()).toMatch(
      /clerum_hcc_existence_reads_total\{kind="Service",outcome="found"[^}]*\} 1/
    )
  })

  const policy: k8s.V1NetworkPolicy = {
    kind: 'NetworkPolicy',
    metadata: { name: 'read-metrics-policy' },
    spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] },
  }

  it('observes GET404 before POST for an absent policy', async () => {
    const api = {
      createNamespacedNetworkPolicy: vi.fn().mockResolvedValue(policy),
      readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
    }
    await applyNetworkPolicy(
      api as unknown as k8s.NetworkingV1Api,
      'read-metrics-policy',
      'test',
      policy
    )
    expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledExactlyOnceWith({
      namespace: 'test',
      body: policy,
    })
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledExactlyOnceWith({
      name: 'read-metrics-policy',
      namespace: 'test',
    })
    expect(await count('NetworkPolicy', 'absent')).toBe(1)
    expect(await count('NetworkPolicy', 'found')).toBe(0)
  })

  it('attributes GET conflicts to reads without adding POST conflicts or retrying', async () => {
    const error = { response: { statusCode: 409 } }
    const api = {
      createNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 409 }),
      readNamespacedNetworkPolicy: vi.fn().mockRejectedValue(error),
      replaceNamespacedNetworkPolicy: vi.fn(),
    }
    await expect(
      applyNetworkPolicy(
        api as unknown as k8s.NetworkingV1Api,
        'read-metrics-policy',
        'test',
        policy
      )
    ).rejects.toBe(error)
    expect(api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledExactlyOnceWith({
      name: 'read-metrics-policy',
      namespace: 'test',
    })
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(await count('NetworkPolicy', 'error')).toBe(1)
    const samples = (await createsTotal.get()).values.filter(
      sample => sample.labels.kind === 'NetworkPolicy'
    )
    expect(samples.map(sample => [sample.labels.outcome, sample.value])).toEqual([
      ['created', 0],
      ['conflict', 0],
      ['error', 0],
      ['skipped', 0],
    ])
  })

  it('counts physical retry reads once and preserves fresh resource versions', async () => {
    const events: string[] = []
    let reads = 0
    const api = {
      createNamespacedNetworkPolicy: vi.fn(async () => {
        events.push('POST')
        throw { code: 409 }
      }),
      readNamespacedNetworkPolicy: vi.fn(async () => {
        events.push('GET')
        return {
          ...policy,
          metadata: { ...policy.metadata, resourceVersion: String(++reads) },
          spec: { ...policy.spec, ingress: [{}] },
        }
      }),
      replaceNamespacedNetworkPolicy: vi.fn(async ({ body }: { body: k8s.V1NetworkPolicy }) => {
        events.push('PUT:' + body.metadata?.resourceVersion)
        if (body.metadata?.resourceVersion === '1') throw { code: 409 }
        return body
      }),
    }
    await applyNetworkPolicy(
      api as unknown as k8s.NetworkingV1Api,
      'read-metrics-policy',
      'test',
      policy
    )
    expect(events).toEqual(['GET', 'PUT:1', 'GET', 'PUT:2'])
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    expect(api.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    expect(await count('NetworkPolicy', 'found')).toBe(2)
    expect(await count('NetworkPolicy', 'error')).toBe(0)
    const conflicts = (await createsTotal.get()).values.find(
      sample => sample.labels.kind === 'NetworkPolicy' && sample.labels.outcome === 'conflict'
    )
    expect(conflicts?.value).toBe(0)
    expect(api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    const skipped = (await createsTotal.get()).values.find(
      sample => sample.labels.kind === 'NetworkPolicy' && sample.labels.outcome === 'skipped'
    )
    expect(skipped?.value).toBe(1)
  })

  it('observes a read that expires the existing fence and prevents replace', async () => {
    let active = true
    const allowed = vi.fn(() => active)
    const api = {
      createNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 409 }),
      readNamespacedNetworkPolicy: vi.fn(async () => {
        active = false
        return { ...policy, spec: { ...policy.spec, ingress: [{}] } }
      }),
      replaceNamespacedNetworkPolicy: vi.fn(),
    }
    await applyNetworkPolicy(
      api as unknown as k8s.NetworkingV1Api,
      'read-metrics-policy',
      'test',
      policy,
      '[test]',
      allowed
    )
    expect(allowed.mock.results.map(result => result.value)).toEqual([true, false])
    expect(api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(await count('NetworkPolicy', 'found')).toBe(1)
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })
})
