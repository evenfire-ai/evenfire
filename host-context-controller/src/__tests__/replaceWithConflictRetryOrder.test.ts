import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { preserveServiceAssignedFields, replaceWithConflictRetry } from '../utils'

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

  it('RETRY-SVC-1: 409 then success logs after 2 attempts', async () => {
    const replace = vi.fn().mockRejectedValueOnce({ code: 409 }).mockResolvedValueOnce({})
    const log = vi.spyOn(console, 'log')
    try {
      await replaceWithConflictRetry({
        description: 'Service "svc"',
        logPrefix: '[Test]',
        body: desired,
        mergeExisting: preserveServiceAssignedFields,
        isUpToDate: () => false,
        read: async () => existing,
        replace,
      })

      expect(replace).toHaveBeenCalledTimes(2)
      const updated = log.mock.calls
        .map(call => String(call[0]))
        .filter(line => line.includes('[Test] Updated Service "svc"'))
      expect(updated).toEqual(['[Test] Updated Service "svc" (after 2 attempts)'])
    } finally {
      log.mockRestore()
    }
  })
})
