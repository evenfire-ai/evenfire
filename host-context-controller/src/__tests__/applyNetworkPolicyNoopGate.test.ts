import { describe, expect, it, vi } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import type * as k8s from '@kubernetes/client-node'
import { applyNetworkPolicy, networkPolicyMatchesDesired } from '../utils'
import { asApiserverNetworkPolicy, updatedPolicyLogs } from './asApiserverNetworkPolicy'

function apiException(code: number): ApiException<unknown> {
  return new ApiException(code, 'test', {}, {})
}

function desiredPolicy(): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'np', namespace: 'ns', labels: { app: 'np' } },
    spec: {
      podSelector: { matchLabels: { app: 'np' } },
      ingress: [
        {
          _from: [{ podSelector: { matchLabels: { app: 'peer' } } }],
          ports: [{ port: 8080 }],
        },
      ],
    },
  }
}

function fakeNetworkingApi() {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn(),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  }
}

describe('applyNetworkPolicy no-op gate', () => {
  it('CREATE-NP-1: absent policy creates after one GET and never replaces', async () => {
    const api = fakeNetworkingApi()
    api.readNamespacedNetworkPolicy.mockRejectedValueOnce(apiException(404))
    await applyNetworkPolicy(api as unknown as k8s.NetworkingV1Api, 'np', 'ns', desiredPolicy())
    expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledOnce()
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledExactlyOnceWith({
      name: 'np',
      namespace: 'ns',
    })
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('NOOP-NP-1 / LOG-NP-1: equivalent recorded existing skips replace and Updated logs', async () => {
    const desired = desiredPolicy()
    const existing = asApiserverNetworkPolicy(desired)
    expect(existing.spec).toBeDefined()
    const api = fakeNetworkingApi()
    api.readNamespacedNetworkPolicy.mockResolvedValue(existing)
    const log = vi.spyOn(console, 'log')
    try {
      await applyNetworkPolicy(api as unknown as k8s.NetworkingV1Api, 'np', 'ns', desired)
      expect(api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledOnce()
      expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(updatedPolicyLogs(log, 'policy "np" in ns')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-NP-2 / LOG-NP-2: drift replaces once and logs once', async () => {
    const desired = desiredPolicy()
    const api = fakeNetworkingApi()
    api.readNamespacedNetworkPolicy.mockResolvedValue(
      asApiserverNetworkPolicy(desired, { port: 9090 })
    )
    const log = vi.spyOn(console, 'log')
    try {
      await applyNetworkPolicy(api as unknown as k8s.NetworkingV1Api, 'np', 'ns', desired)
      expect(api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledOnce()
      expect(api.replaceNamespacedNetworkPolicy).toHaveBeenCalledOnce()
      expect(updatedPolicyLogs(log, 'policy "np" in ns')).toEqual([
        '[NetPol] Updated policy "np" in ns',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('ORDER-NP-1: validateExisting throws before isUpToDate; replace is not called', async () => {
    const desired = desiredPolicy()
    const api = fakeNetworkingApi()
    api.readNamespacedNetworkPolicy.mockResolvedValue(asApiserverNetworkPolicy(desired))
    const validateExisting = vi.fn(() => {
      throw new Error('NetworkPolicy "np" has conflicting ownership for the context-ingress lane')
    })

    await expect(
      applyNetworkPolicy(
        api as unknown as k8s.NetworkingV1Api,
        'np',
        'ns',
        desired,
        '[NetPol]',
        undefined,
        validateExisting
      )
    ).rejects.toThrow(/ownership/)

    expect(validateExisting).toHaveBeenCalledExactlyOnceWith(asApiserverNetworkPolicy(desired))
    expect(api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it.each([
    { form: 'ApiException', error: apiException(404) },
    { form: 'statusCode', error: { response: { statusCode: 404 } } },
  ])(
    'TOCTOU-NP-1: GET404 + create409 + fresh GET404 ($form) returns without replace',
    async ({ error }) => {
      const api = fakeNetworkingApi()
      api.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
      api.readNamespacedNetworkPolicy
        .mockRejectedValueOnce(apiException(404))
        .mockRejectedValueOnce(error)

      await expect(
        applyNetworkPolicy(api as unknown as k8s.NetworkingV1Api, 'np', 'ns', desiredPolicy())
      ).resolves.toBeUndefined()

      expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledOnce()
      expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    }
  )

  it.each([
    { form: 'ApiException', error: apiException(404) },
    { form: 'statusCode', error: { response: { statusCode: 404 } } },
  ])(
    'admission-sensitive GET404/create409/fresh GET404 ($form) rejects instead of certifying absence',
    async ({ error }) => {
      const api = fakeNetworkingApi()
      api.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
      api.readNamespacedNetworkPolicy
        .mockRejectedValueOnce(apiException(404))
        .mockRejectedValueOnce(error)

      await expect(
        applyNetworkPolicy(
          api as unknown as k8s.NetworkingV1Api,
          'np',
          'ns',
          desiredPolicy(),
          '[NetPol]',
          undefined,
          undefined,
          true
        )
      ).rejects.toBe(error)

      expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledOnce()
      expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    }
  )

  it.each([
    { status: 403, form: 'ApiException', error: apiException(403) },
    { status: 403, form: 'statusCode', error: { response: { statusCode: 403 } } },
    { status: 500, form: 'ApiException', error: apiException(500) },
    { status: 500, form: 'statusCode', error: { response: { statusCode: 500 } } },
  ])(
    'TOCTOU-NP-2-APPLY: GET404 + create409 + fresh GET$status ($form) still throws',
    async ({ error }) => {
      const api = fakeNetworkingApi()
      api.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
      api.readNamespacedNetworkPolicy
        .mockRejectedValueOnce(apiException(404))
        .mockRejectedValueOnce(error)

      await expect(
        applyNetworkPolicy(api as unknown as k8s.NetworkingV1Api, 'np', 'ns', desiredPolicy())
      ).rejects.toBe(error)

      expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledOnce()
      expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    }
  )

  it('GATE-NP-0: mutation denied at entry skips GET and all writes', async () => {
    const api = fakeNetworkingApi()
    const mutationAllowed = vi.fn(() => false)

    await expect(
      applyNetworkPolicy(
        api as unknown as k8s.NetworkingV1Api,
        'np',
        'ns',
        desiredPolicy(),
        '[NetPol]',
        mutationAllowed
      )
    ).resolves.toBeUndefined()

    expect(mutationAllowed).toHaveBeenCalledOnce()
    expect(api.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('GATE-NP-1: expiry during existence GET suppresses POST and drift PUT', async () => {
    const desired = desiredPolicy()
    const drifted = asApiserverNetworkPolicy(desired, { port: 9090 })
    expect(networkPolicyMatchesDesired(desired, drifted)).toBe(false)
    const api = fakeNetworkingApi()
    let active = true
    api.readNamespacedNetworkPolicy.mockImplementation(async () => {
      active = false
      return drifted
    })
    const mutationAllowed = vi.fn(() => active)

    await applyNetworkPolicy(
      api as unknown as k8s.NetworkingV1Api,
      'np',
      'ns',
      desired,
      '[NetPol]',
      mutationAllowed
    )

    expect(mutationAllowed.mock.results.map(result => result.value)).toEqual([true, false])
    expect(api.readNamespacedNetworkPolicy).toHaveBeenCalledOnce()
    expect(api.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })
})
