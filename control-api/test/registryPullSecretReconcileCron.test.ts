/**
 * The reconcile loop that makes the platform pull credential a standing invariant.
 *
 * The property under test is the one that differs from the install path: a precondition
 * failure here must be LOGGED AND RETRIED, never thrown. An install throws because a user
 * asked for something we cannot deliver; this loop runs unprompted on every cluster,
 * including ones that have not finished the registry connect flow, and must not turn that
 * normal state into recurring errors or a crash loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { K8sGateway } from '../src/k8s.js'
import {
  reconcileRegistryPullSecret,
  startRegistryPullSecretReconcileCron,
  stopRegistryPullSecretReconcileCron,
} from '../src/services/registryPullSecretReconcileCron.js'

const ensureRegistryPullSecrets = vi.hoisted(() => vi.fn())
vi.mock('../src/services/registryPullSecretService.js', () => ({
  ensureRegistryPullSecrets,
  platformWorkloadNamespaces: () => ['mcp-server', 'sandbox-recipes', 'sandbox-ui'],
}))

const gateway = {} as K8sGateway

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  stopRegistryPullSecretReconcileCron()
  vi.useRealTimers()
})

describe('reconcileRegistryPullSecret', () => {
  it('provisions across every platform namespace', async () => {
    ensureRegistryPullSecrets.mockResolvedValue(
      new Map([
        ['mcp-server', 'created'],
        ['sandbox-recipes', 'created'],
        ['sandbox-ui', 'created'],
      ])
    )
    await expect(reconcileRegistryPullSecret(gateway)).resolves.toBe(true)
    expect(ensureRegistryPullSecrets).toHaveBeenCalledWith(gateway, [
      'mcp-server',
      'sandbox-recipes',
      'sandbox-ui',
    ])
  })

  it('does NOT throw when the cluster is not connected yet — it retries next tick', async () => {
    // The exact state a freshly-deployed, unconnected cluster is in. Throwing here would
    // crash-loop the process or spam an error every interval.
    const err = Object.assign(new Error('registry connection is not active'), {
      reason: 'registry_not_connected',
    })
    ensureRegistryPullSecrets.mockRejectedValue(err)
    await expect(reconcileRegistryPullSecret(gateway)).resolves.toBe(false)
  })

  it('does NOT throw when no org is bound yet', async () => {
    ensureRegistryPullSecrets.mockRejectedValue(
      Object.assign(new Error('no org'), { reason: 'org_unresolved' })
    )
    await expect(reconcileRegistryPullSecret(gateway)).resolves.toBe(false)
  })

  it('swallows an unexpected error rather than escaping the timer callback', async () => {
    ensureRegistryPullSecrets.mockRejectedValue(new Error('boom'))
    await expect(reconcileRegistryPullSecret(gateway)).resolves.toBe(false)
  })

  it('reports success without provisioning when everything is already in place', async () => {
    ensureRegistryPullSecrets.mockResolvedValue(new Map([['mcp-server', 'exists-ours']]))
    await expect(reconcileRegistryPullSecret(gateway)).resolves.toBe(true)
  })
})

describe('startRegistryPullSecretReconcileCron', () => {
  it('runs on the interval and is idempotent to start', async () => {
    vi.useFakeTimers()
    ensureRegistryPullSecrets.mockResolvedValue(new Map())

    startRegistryPullSecretReconcileCron(gateway, 1000)
    // A second start must not install a second timer (which would double the mint rate).
    startRegistryPullSecretReconcileCron(gateway, 1000)

    await vi.advanceTimersByTimeAsync(3000)
    expect(ensureRegistryPullSecrets).toHaveBeenCalledTimes(3)
  })

  it('stops cleanly', async () => {
    vi.useFakeTimers()
    ensureRegistryPullSecrets.mockResolvedValue(new Map())
    startRegistryPullSecretReconcileCron(gateway, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    stopRegistryPullSecretReconcileCron()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ensureRegistryPullSecrets).toHaveBeenCalledTimes(1)
  })
})
