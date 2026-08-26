import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  preserveServiceAssignedFields,
  replaceWithConflictRetry,
  serviceMatchesDesired,
} from '../utils'

const desired: k8s.V1Service = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'svc', namespace: 'ns', labels: { app: 'svc' } },
  spec: { selector: { app: 'svc' }, ports: [{ name: 'http', port: 8080 }] },
}

const existing: k8s.V1Service = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    name: 'svc',
    namespace: 'ns',
    labels: { app: 'svc' },
    resourceVersion: '9',
    uid: 'uid-svc',
  },
  spec: {
    type: 'ClusterIP',
    sessionAffinity: 'None',
    clusterIP: '10.96.14.7',
    selector: { app: 'svc' },
    ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
  },
  status: { loadBalancer: {} },
}

describe('replaceWithConflictRetry order and retry', () => {
  it('ORDER-1: validateExisting throws before isUpToDate is consulted', async () => {
    const replace = vi.fn()
    const isUpToDate = vi.fn(() => true)
    const validateExisting = vi.fn(() => {
      throw new Error('unsafe to replace')
    })

    await expect(
      replaceWithConflictRetry({
        description: 'Service "svc"',
        logPrefix: '[Test]',
        body: desired,
        mergeExisting: preserveServiceAssignedFields,
        isUpToDate,
        validateExisting,
        read: async () => existing,
        replace,
      })
    ).rejects.toThrow('unsafe to replace')

    expect(validateExisting).toHaveBeenCalledOnce()
    expect(isUpToDate).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('RETRY-SVC-1: 409 then success threads the fresh resourceVersion', async () => {
    const firstRead: k8s.V1Service = {
      ...existing,
      metadata: { ...existing.metadata, resourceVersion: '9' },
    }
    const secondRead: k8s.V1Service = {
      ...existing,
      metadata: { ...existing.metadata, resourceVersion: '10' },
    }
    const read = vi.fn().mockResolvedValueOnce(firstRead).mockResolvedValueOnce(secondRead)
    const replace = vi.fn().mockRejectedValueOnce({ code: 409 }).mockResolvedValueOnce({})
    const log = vi.spyOn(console, 'log')
    try {
      await replaceWithConflictRetry({
        description: 'Service "svc"',
        logPrefix: '[Test]',
        body: desired,
        mergeExisting: preserveServiceAssignedFields,
        isUpToDate: () => false,
        read,
        replace,
      })

      expect(replace).toHaveBeenCalledTimes(2)
      expect(replace.mock.calls[0][0].metadata?.resourceVersion).toBe('9')
      expect(replace.mock.calls[1][0].metadata?.resourceVersion).toBe('10')
      const updated = log.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .filter((line: string) => line.includes('[Test] Updated Service "svc"'))
      expect(updated).toEqual(['[Test] Updated Service "svc" (after 2 attempts)'])
    } finally {
      log.mockRestore()
    }
  })

  it('RETRY-SVC-2: post-409 re-read that matches skips the second replace', async () => {
    const drifted: k8s.V1Service = {
      ...existing,
      metadata: { ...existing.metadata, resourceVersion: '9' },
      spec: {
        ...existing.spec,
        ports: [{ name: 'http', port: 9090, protocol: 'TCP' }],
      },
    }
    const converged: k8s.V1Service = {
      ...existing,
      metadata: { ...existing.metadata, resourceVersion: '10' },
    }
    const read = vi.fn().mockResolvedValueOnce(drifted).mockResolvedValueOnce(converged)
    const replace = vi.fn().mockRejectedValueOnce({ code: 409 })

    await replaceWithConflictRetry({
      description: 'Service "svc"',
      logPrefix: '[Test]',
      body: desired,
      mergeExisting: preserveServiceAssignedFields,
      isUpToDate: serviceMatchesDesired,
      read,
      replace,
    })

    expect(replace).toHaveBeenCalledOnce()
    expect(replace.mock.calls[0][0].metadata?.resourceVersion).toBe('9')
    expect(read).toHaveBeenCalledTimes(2)
  })
})
