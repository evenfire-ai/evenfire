import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { CREATE_KINDS, createsTotal, registry } from './metrics'
import { applyNetworkPolicy, observeCreate } from './utils'

async function count(kind: string, outcome: string): Promise<number> {
  const snapshot = await createsTotal.get()
  const sample = snapshot.values.find(v => v.labels.kind === kind && v.labels.outcome === outcome)
  expect(sample, `Missing ${kind}/${outcome} sample`).toBeDefined()
  return sample!.value
}

it('initializes create samples in the real registry before any test seeding', async () => {
  expect(registry.getSingleMetric('clerum_hcc_creates_total')).toBe(createsTotal)
  for (const kind of CREATE_KINDS) {
    for (const outcome of ['issued', 'conflict', 'skipped']) {
      expect(await count(kind, outcome)).toBe(0)
    }
  }
})

describe('Kubernetes create instrumentation', () => {
  beforeEach(() => {
    createsTotal.reset()
    for (const kind of CREATE_KINDS) {
      for (const outcome of ['issued', 'conflict', 'skipped']) {
        createsTotal.inc({ kind, outcome }, 0)
      }
    }
  })

  it('instruments the complete production create inventory with the matching kind', () => {
    const kinds: string[] = []
    const root = new URL('.', import.meta.url).pathname
    for (const relative of readdirSync(root, { recursive: true }) as string[]) {
      if (
        !relative.endsWith('.ts') ||
        relative.endsWith('.test.ts') ||
        relative.includes('__tests__')
      )
        continue
      const file = ts.createSourceFile(
        relative,
        readFileSync(join(root, relative), 'utf8'),
        ts.ScriptTarget.Latest,
        true
      )
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const match = /^create(?:Namespaced|Cluster)(.+)$/.exec(node.expression.name.text)
          if (match) {
            kinds.push(match[1])
            const arrow = node.parent
            expect(ts.isArrowFunction(arrow), `${relative}: ${node.expression.name.text}`).toBe(
              true
            )
            const wrapper = arrow.parent
            expect(ts.isCallExpression(wrapper)).toBe(true)
            if (ts.isCallExpression(wrapper)) {
              expect(wrapper.expression.getText(file)).toBe('observeCreate')
              expect(wrapper.arguments[0].getText(file)).toBe(`'${match[1]}'`)
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    expect(kinds).toHaveLength(24)
    expect([...new Set(kinds)].sort()).toEqual([...CREATE_KINDS].sort())
  })

  it('preserves a synchronous client failure and counts the attempt', async () => {
    const error = new Error('client request construction failed')
    const create = vi.fn(() => {
      throw error
    })
    await expect(observeCreate('Service', create)).rejects.toBe(error)
    expect(create).toHaveBeenCalledTimes(1)
    expect(await count('Service', 'issued')).toBe(1)
    expect(await count('Service', 'conflict')).toBe(0)
  })

  it('preserves real registry samples and nonzero counts across re-import', async () => {
    // Existing observations must survive module initialization without being reset.
    const create = vi.fn().mockResolvedValue({})
    await observeCreate('Service', create)
    expect(create).toHaveBeenCalledTimes(1)
    vi.resetModules()
    const reloaded = await import('./metrics')
    expect(reloaded.registry).toBe(registry)
    expect(reloaded.createsTotal).toBe(createsTotal)
    const exposition = await registry.metrics()
    for (const kind of CREATE_KINDS) {
      for (const outcome of ['issued', 'conflict', 'skipped']) {
        expect(exposition).toContain(`clerum_hcc_creates_total{kind="${kind}",outcome="${outcome}"`)
        expect(await count(kind, outcome)).toBe(kind === 'Service' && outcome === 'issued' ? 1 : 0)
      }
    }
  })

  it('issues exactly once and returns the original server response', async () => {
    const response = { metadata: { uid: 'created-policy', resourceVersion: '17' } }
    const create = vi.fn(async () => {
      expect(await count('NetworkPolicy', 'issued')).toBe(1)
      return response
    })
    expect(await observeCreate('NetworkPolicy', create)).toBe(response)
    expect(create).toHaveBeenCalledTimes(1)
    expect(await count('NetworkPolicy', 'issued')).toBe(1)
    expect(await count('NetworkPolicy', 'conflict')).toBe(0)
    expect(await count('NetworkPolicy', 'skipped')).toBe(0)
  })

  it.each([{ code: 409 }, { response: { statusCode: 409 } }])(
    'counts a conflict as a subset of attempts and preserves the error: %j',
    async error => {
      const create = vi.fn().mockRejectedValue(error)
      await expect(observeCreate('Service', create)).rejects.toBe(error)
      expect(create).toHaveBeenCalledTimes(1)
      expect(await count('Service', 'issued')).toBe(1)
      expect(await count('Service', 'conflict')).toBe(1)
      expect(await count('Service', 'skipped')).toBe(0)
    }
  )

  it.each([{ code: 403 }, { code: 500 }, { code: 'ECONNRESET' }, null, undefined])(
    'propagates non-conflict errors without retrying or counting a conflict: %j',
    async error => {
      const create = vi.fn().mockRejectedValue(error)
      await expect(observeCreate('Deployment', create)).rejects.toBe(error)
      expect(create).toHaveBeenCalledTimes(1)
      expect(await count('Deployment', 'issued')).toBe(1)
      expect(await count('Deployment', 'conflict')).toBe(0)
    }
  )

  it('observes the existing POST-first conflict path without counting replace conflicts', async () => {
    const policy: k8s.V1NetworkPolicy = {
      kind: 'NetworkPolicy',
      metadata: { name: 'metrics-policy' },
      spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] },
    }
    const api = {
      createNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 409 }),
      readNamespacedNetworkPolicy: vi.fn().mockResolvedValue(policy),
      replaceNamespacedNetworkPolicy: vi.fn(),
    }
    await applyNetworkPolicy(
      api as unknown as k8s.NetworkingV1Api,
      'metrics-policy',
      'test',
      policy
    )
    expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(await count('NetworkPolicy', 'issued')).toBe(1)
    expect(await count('NetworkPolicy', 'conflict')).toBe(1)
    expect(await count('NetworkPolicy', 'skipped')).toBe(0)
  })

  it('does not count a create when its mutation fence has already expired', async () => {
    const allowed = vi.fn(() => false)
    const create = vi.fn()
    await applyNetworkPolicy(
      { createNamespacedNetworkPolicy: create } as unknown as k8s.NetworkingV1Api,
      'metrics-policy',
      'test',
      {},
      '[test]',
      allowed
    )
    expect(allowed).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(await count('NetworkPolicy', 'issued')).toBe(0)
    expect(await count('NetworkPolicy', 'skipped')).toBe(0)
  })
})
