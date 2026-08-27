import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { applyNetworkPolicy, networkPolicyMatchesDesired } from '../utils'
import { asApiserverNetworkPolicy, updatedPolicyLogs } from './asApiserverNetworkPolicy'

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
  it('CREATE-NP-1: successful create never reads or replaces', async () => {
    const api = fakeNetworkingApi()
    await applyNetworkPolicy(api as unknown as k8s.NetworkingV1Api, 'np', 'ns', desiredPolicy())
    expect(api.createNamespacedNetworkPolicy).toHaveBeenCalledOnce()
    expect(api.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('NOOP-NP-1 / LOG-NP-1: equivalent recorded existing skips replace and Updated logs', async () => {
    const desired = desiredPolicy()
    const existing = asApiserverNetworkPolicy(desired)
    expect(existing.spec).toBeDefined()
    const api = fakeNetworkingApi()
    api.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    api.readNamespacedNetworkPolicy.mockResolvedValue(existing)
    const log = vi.spyOn(console, 'log')
    try {
      await applyNetworkPolicy(api as unknown as k8s.NetworkingV1Api, 'np', 'ns', desired)
      expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(updatedPolicyLogs(log, 'policy "np" in ns')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-NP-2 / LOG-NP-2: drift replaces once and logs once', async () => {
    const desired = desiredPolicy()
    const api = fakeNetworkingApi()
    api.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    api.readNamespacedNetworkPolicy.mockResolvedValue(
      asApiserverNetworkPolicy(desired, { port: 9090 })
    )
    const log = vi.spyOn(console, 'log')
    try {
      await applyNetworkPolicy(api as unknown as k8s.NetworkingV1Api, 'np', 'ns', desired)
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
    api.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
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

    expect(validateExisting).toHaveBeenCalledOnce()
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('GATE-NP-1: mutationAllowed false after create-409 skips replace on drift', async () => {
    const desired = desiredPolicy()
    const drifted = asApiserverNetworkPolicy(desired, { port: 9090 })
    expect(networkPolicyMatchesDesired(desired, drifted)).toBe(false)
    const api = fakeNetworkingApi()
    api.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    api.readNamespacedNetworkPolicy.mockResolvedValue(drifted)
    const mutationAllowed = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)

    await applyNetworkPolicy(
      api as unknown as k8s.NetworkingV1Api,
      'np',
      'ns',
      desired,
      '[NetPol]',
      mutationAllowed
    )

    expect(mutationAllowed).toHaveBeenCalledTimes(2)
    expect(api.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })
})
