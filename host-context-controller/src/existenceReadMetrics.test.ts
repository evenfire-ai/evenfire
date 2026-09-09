import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { readFileSync } from 'node:fs'
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

it('observes the documented physical GET expressions without wrapping snapshots or lists', () => {
  const inventory: Record<string, number> = {
    'utils.ts': 1,
    'hostReconciler.ts': 8,
    'reconciler.ts': 3,
    'llmHookReconciler.ts': 3,
    'sharedFileSystemReconciler.ts': 1,
    'k8s/gfsK8sApi.ts': 3,
    'networkPolicyReconciler.ts': 2,
  }
  let total = 0
  for (const [path, expected] of Object.entries(inventory)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(join(__dirname, path), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    let calls = 0
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'observeExistenceRead'
      ) {
        calls++
        const [kind, read] = node.arguments
        expect(ts.isStringLiteral(kind), path).toBe(true)
        expect(ts.isArrowFunction(read), path).toBe(true)
        if (ts.isStringLiteral(kind) && ts.isArrowFunction(read)) {
          expect(ts.isCallExpression(read.body), path).toBe(true)
          if (
            ts.isCallExpression(read.body) &&
            ts.isPropertyAccessExpression(read.body.expression)
          ) {
            expect(read.body.expression.name.text, path).toBe(`readNamespaced${kind.text}`)
          } else throw new Error(`${path}: the wrapper must observe a direct API read`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(calls, path).toBe(expected)
    total += calls
  }
  expect(total).toBe(21)
})

describe('Kubernetes existence-read instrumentation', () => {
  beforeEach(() => {
    existenceReadsTotal.reset()
    createsTotal.reset()
    for (const kind of CREATE_KINDS) {
      for (const outcome of ['found', 'absent', 'error'])
        existenceReadsTotal.inc({ kind, outcome }, 0)
      for (const outcome of ['issued', 'conflict', 'skipped'])
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

  it('preserves POST-first success without adding an existence request', async () => {
    const api = {
      createNamespacedNetworkPolicy: vi.fn().mockResolvedValue(policy),
      readNamespacedNetworkPolicy: vi.fn(),
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
    expect(api.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
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
    expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
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
      ['issued', 1],
      ['conflict', 1],
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
    expect(events).toEqual(['POST', 'GET', 'PUT:1', 'GET', 'PUT:2'])
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    expect(api.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    expect(await count('NetworkPolicy', 'found')).toBe(2)
    expect(await count('NetworkPolicy', 'error')).toBe(0)
    const conflicts = (await createsTotal.get()).values.find(
      sample => sample.labels.kind === 'NetworkPolicy' && sample.labels.outcome === 'conflict'
    )
    expect(conflicts?.value).toBe(1)
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
    expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(await count('NetworkPolicy', 'found')).toBe(1)
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })
})
