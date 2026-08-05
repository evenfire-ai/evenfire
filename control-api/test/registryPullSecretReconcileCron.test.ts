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

// The log LEVEL is part of this loop's contract, not decoration: it runs unprompted on every
// cluster, so a level chosen per-state is what keeps a normal pre-connect cluster from
// looking broken while a genuinely stuck one stays findable.
const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
vi.mock('../src/observability/logger.js', () => ({ rootLogger: { child: () => log } }))

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
    // `required: []` is load-bearing, not decoration: this loop is not a caller about to
    // persist a CRD, so it must never fail on a namespace nobody has asked for. It is what
    // keeps a managed cluster — where control-api provisions nothing and the operator may
    // not have populated every namespace — from reporting a failed pass on every tick.
    expect(ensureRegistryPullSecrets).toHaveBeenCalledWith(
      gateway,
      ['mcp-server', 'sandbox-recipes', 'sandbox-ui'],
      { required: [] }
    )
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

/**
 * Level selection. `registry_not_connected` and `org_unresolved` are states this loop's own
 * comment calls expected — a cluster that has not finished the connect flow is not
 * misconfigured, it is early — and at the default interval a warn per tick is 144 warnings a
 * day that mean nothing. But "expected" stops being true if it never resolves, so the signal
 * has to survive somewhere an operator will look.
 */
describe('reconcileRegistryPullSecret — log level', () => {
  const notConnected = () =>
    Object.assign(new Error('registry connection is not active'), {
      reason: 'registry_not_connected',
    })

  it.each(['registry_not_connected', 'org_unresolved'])(
    'logs %s below warn while it is still a plausible startup state',
    async reason => {
      ensureRegistryPullSecrets.mockRejectedValue(Object.assign(new Error('nope'), { reason }))
      await expect(reconcileRegistryPullSecret(gateway)).resolves.toBe(false)
      expect(log.warn).not.toHaveBeenCalled()
      expect(log.debug).toHaveBeenCalled()
    }
  )

  // Not "quiet forever": a precondition that has held for this many consecutive ticks is a
  // cluster somebody has to look at, and the operator debugging it greps for warnings.
  it('escalates to warn once a known precondition persists', async () => {
    ensureRegistryPullSecrets.mockRejectedValue(notConnected())
    for (let i = 0; i < 5; i += 1) {
      await reconcileRegistryPullSecret(gateway)
    }
    expect(log.warn).not.toHaveBeenCalled()

    await reconcileRegistryPullSecret(gateway)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatchObject({ reason: 'registry_not_connected' })
  })

  // An unexpected failure has no "this is normal at first" story, so it warns on tick one.
  it('warns immediately on an unexpected failure', async () => {
    ensureRegistryPullSecrets.mockRejectedValue(new Error('boom'))
    await expect(reconcileRegistryPullSecret(gateway)).resolves.toBe(false)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  // A cluster that connects mid-run is back to normal, and the count that would escalate the
  // NEXT transient precondition has to go with it — otherwise one bad hour makes every later
  // blip look persistent.
  it('resets the escalation count after a pass succeeds', async () => {
    ensureRegistryPullSecrets.mockRejectedValue(notConnected())
    for (let i = 0; i < 5; i += 1) {
      await reconcileRegistryPullSecret(gateway)
    }
    ensureRegistryPullSecrets.mockResolvedValue(new Map())
    await reconcileRegistryPullSecret(gateway)

    ensureRegistryPullSecrets.mockRejectedValue(notConnected())
    await reconcileRegistryPullSecret(gateway)
    expect(log.warn).not.toHaveBeenCalled()
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
