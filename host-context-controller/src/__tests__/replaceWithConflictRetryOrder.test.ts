import { describe, expect, it, vi } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import type * as k8s from '@kubernetes/client-node'
import {
  preserveServiceAssignedFields,
  replaceWithConflictRetry,
  serviceMatchesDesired,
} from '../utils'

function apiException(code: number): ApiException<unknown> {
  return new ApiException(code, 'test', {}, {})
}

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

  it.each([
    { status: 403, form: 'ApiException', error: apiException(403) },
    { status: 403, form: 'statusCode', error: { response: { statusCode: 403 } } },
    { status: 500, form: 'ApiException', error: apiException(500) },
    { status: 500, form: 'statusCode', error: { response: { statusCode: 500 } } },
  ])('TOCTOU-NP-2: helper read $status ($form) still throws', async ({ error }) => {
    const replace = vi.fn()
    const validateExisting = vi.fn()
    const read = vi.fn().mockRejectedValue(error)

    await expect(
      replaceWithConflictRetry({
        description: 'Service "svc"',
        logPrefix: '[Test]',
        body: desired,
        mergeExisting: preserveServiceAssignedFields,
        isUpToDate: serviceMatchesDesired,
        validateExisting,
        read,
        replace,
      })
    ).rejects.toBe(error)

    expect(read).toHaveBeenCalledOnce()
    expect(validateExisting).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it.each([
    { form: 'ApiException', error: apiException(404) },
    { form: 'statusCode', error: { response: { statusCode: 404 } } },
  ])(
    'TOCTOU-NP-3: replace 409 then second read 404 ($form) returns without a third replace',
    async ({ error }) => {
      const read = vi.fn().mockResolvedValueOnce(existing).mockRejectedValueOnce(error)
      const replace = vi.fn().mockRejectedValueOnce({ code: 409 })
      const validateExisting = vi.fn()

      await expect(
        replaceWithConflictRetry({
          description: 'Service "svc"',
          logPrefix: '[Test]',
          body: desired,
          mergeExisting: preserveServiceAssignedFields,
          isUpToDate: () => false,
          validateExisting,
          read,
          replace,
        })
      ).resolves.toBeUndefined()

      expect(read).toHaveBeenCalledTimes(2)
      expect(validateExisting).toHaveBeenCalledOnce()
      expect(replace).toHaveBeenCalledOnce()
      expect(replace.mock.calls[0][0].metadata?.resourceVersion).toBe('9')
    }
  )

  it('TOCTOU-NP-4: network Error without code is rethrown', async () => {
    const networkErr = new Error('socket hang up')
    const replace = vi.fn()
    const validateExisting = vi.fn()
    const read = vi.fn().mockRejectedValue(networkErr)

    await expect(
      replaceWithConflictRetry({
        description: 'Service "svc"',
        logPrefix: '[Test]',
        body: desired,
        mergeExisting: preserveServiceAssignedFields,
        isUpToDate: serviceMatchesDesired,
        validateExisting,
        read,
        replace,
      })
    ).rejects.toBe(networkErr)

    expect(read).toHaveBeenCalledOnce()
    expect(validateExisting).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it.each([
    { form: 'ApiException', error: apiException(404) },
    { form: 'statusCode', error: { response: { statusCode: 404 } } },
  ])('TOCTOU-NP-5: helper replace 404 ($form) still throws', async ({ error }) => {
    const read = vi.fn().mockResolvedValue(existing)
    const replace = vi.fn().mockRejectedValue(error)

    await expect(
      replaceWithConflictRetry({
        description: 'Service "svc"',
        logPrefix: '[Test]',
        body: desired,
        mergeExisting: preserveServiceAssignedFields,
        isUpToDate: () => false,
        read,
        replace,
      })
    ).rejects.toBe(error)

    expect(read).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledOnce()
  })

  it.each([
    { status: 403, form: 'ApiException', error: apiException(403) },
    { status: 403, form: 'statusCode', error: { response: { statusCode: 403 } } },
    { status: 500, form: 'ApiException', error: apiException(500) },
    { status: 500, form: 'statusCode', error: { response: { statusCode: 500 } } },
  ])(
    'TOCTOU-NP-6: replace 409 then second read $status ($form) still throws',
    async ({ error }) => {
      const read = vi.fn().mockResolvedValueOnce(existing).mockRejectedValueOnce(error)
      const replace = vi.fn().mockRejectedValueOnce({ code: 409 })
      const validateExisting = vi.fn()

      await expect(
        replaceWithConflictRetry({
          description: 'Service "svc"',
          logPrefix: '[Test]',
          body: desired,
          mergeExisting: preserveServiceAssignedFields,
          isUpToDate: () => false,
          validateExisting,
          read,
          replace,
        })
      ).rejects.toBe(error)

      expect(read).toHaveBeenCalledTimes(2)
      expect(validateExisting).toHaveBeenCalledOnce()
      expect(replace).toHaveBeenCalledOnce()
      expect(replace.mock.calls[0][0].metadata?.resourceVersion).toBe('9')
    }
  )

  it('TOCTOU-NP-7: replace 409 then second-read network Error is rethrown', async () => {
    const networkErr = new Error('socket hang up')
    const read = vi.fn().mockResolvedValueOnce(existing).mockRejectedValueOnce(networkErr)
    const replace = vi.fn().mockRejectedValueOnce({ code: 409 })
    const validateExisting = vi.fn()

    await expect(
      replaceWithConflictRetry({
        description: 'Service "svc"',
        logPrefix: '[Test]',
        body: desired,
        mergeExisting: preserveServiceAssignedFields,
        isUpToDate: () => false,
        validateExisting,
        read,
        replace,
      })
    ).rejects.toBe(networkErr)

    expect(read).toHaveBeenCalledTimes(2)
    expect(validateExisting).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledOnce()
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
