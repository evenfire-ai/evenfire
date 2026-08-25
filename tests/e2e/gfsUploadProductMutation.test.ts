import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type GfsUploadProductEnvPair,
  type GfsUploadProductMutationAdapter,
  type GfsUploadProductMutationLease,
  applyGfsUploadProductMutation,
  beginGfsUploadProductMutation,
  recoverGfsUploadProductMutation,
  restoreGfsUploadProductMutation,
} from './gfsUploadProductMutation'

const baseline: GfsUploadProductEnvPair = {
  canonical: { kind: 'explicit', value: 100 },
  alias: { kind: 'absent' },
}
const changed: GfsUploadProductEnvPair = {
  canonical: { kind: 'explicit', value: 300 },
  alias: { kind: 'explicit', value: 300 },
}

function fixture(initial: GfsUploadProductEnvPair = baseline) {
  let marker: GfsUploadProductMutationLease | undefined
  let current = structuredClone(initial)
  let createObservedPair: GfsUploadProductEnvPair | undefined
  const authorizeNewMutation = vi.fn(async () => ({
    context: 'clerum-issue-300-deadbeef',
    branch: 'feat/issue-300',
    worktreeId: 'worktree',
    gitHead: 'head',
    clusterFingerprint: 'fingerprint',
    preGateMarkerUid: 'pre-gate-uid',
  }))
  const authorizeRecovery = vi.fn(async () => undefined)
  const applyPair = vi.fn(async (pair: GfsUploadProductEnvPair) => {
    current = structuredClone(pair)
  })
  const verifyPair = vi.fn(async (pair: GfsUploadProductEnvPair) => {
    expect(current).toEqual(pair)
  })
  const adapter: GfsUploadProductMutationAdapter = {
    authorizeNewMutation,
    authorizeRecovery,
    readBaseline: vi.fn(async () => structuredClone(baseline)),
    readMarker: vi.fn(async () => (marker ? structuredClone(marker) : undefined)),
    createMarker: vi.fn(async value => {
      createObservedPair = structuredClone(current)
      marker = { uid: 'marker-uid', marker: structuredClone(value) }
      return { uid: marker.uid }
    }),
    applyPair,
    verifyPair,
    deleteMarker: vi.fn(async lease => {
      expect(marker?.uid).toBe(lease.uid)
      marker = undefined
    }),
    newHolder: () => 'holder',
    now: () => '2026-08-24T00:00:00.000Z',
    waitBeforeRetry: vi.fn(async () => undefined),
  }
  return {
    adapter,
    authorizeNewMutation,
    authorizeRecovery,
    applyPair,
    verifyPair,
    getMarker: () => marker,
    setMarker: (value: GfsUploadProductMutationLease | undefined) => {
      marker = value
    },
    getCurrent: () => current,
    getCreateObservedPair: () => createObservedPair,
  }
}

describe('GFS Upload v2 product-limit mutation transaction', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('persists the exact two-input baseline before the first mutation', async () => {
    const runtime = fixture()
    const lease = await beginGfsUploadProductMutation(runtime.adapter)

    expect(runtime.getCreateObservedPair()).toEqual(baseline)
    expect(lease.marker.baseline).toEqual(baseline)

    await applyGfsUploadProductMutation(runtime.adapter, lease, changed)
    expect(runtime.getCurrent()).toEqual(changed)
  })

  it('blocks a new mutation while a recovery marker exists', async () => {
    const runtime = fixture()
    const lease = await beginGfsUploadProductMutation(runtime.adapter)

    await expect(beginGfsUploadProductMutation(runtime.adapter)).rejects.toThrow(
      'recovery is required'
    )
    expect(runtime.getMarker()).toEqual(lease)
  })

  it('restores an owned exact baseline without repeating new-mutation authorization', async () => {
    const runtime = fixture()
    const lease = await beginGfsUploadProductMutation(runtime.adapter)
    await applyGfsUploadProductMutation(runtime.adapter, lease, changed)

    runtime.authorizeNewMutation.mockRejectedValueOnce(new Error('worktree became dirty'))
    await restoreGfsUploadProductMutation(runtime.adapter, lease)

    expect(runtime.authorizeNewMutation).toHaveBeenCalledTimes(1)
    expect(runtime.authorizeRecovery).toHaveBeenCalledWith(lease.marker)
    expect(runtime.getCurrent()).toEqual(baseline)
    expect(runtime.getMarker()).toBeUndefined()
  })

  it('lets another recovery process restore from the durable marker', async () => {
    const first = fixture()
    const lease = await beginGfsUploadProductMutation(first.adapter)
    await applyGfsUploadProductMutation(first.adapter, lease, changed)

    const recovery = fixture(changed)
    recovery.setMarker(lease)
    await recoverGfsUploadProductMutation(recovery.adapter, {
      uid: lease.uid,
      holder: lease.marker.holder,
    })

    expect(recovery.authorizeNewMutation).not.toHaveBeenCalled()
    expect(recovery.authorizeRecovery).toHaveBeenCalledWith(lease.marker)
    expect(recovery.getCurrent()).toEqual(baseline)
    expect(recovery.getMarker()).toBeUndefined()
  })

  it('retries restoration and retains the marker when convergence never verifies', async () => {
    const runtime = fixture()
    const lease = await beginGfsUploadProductMutation(runtime.adapter)
    runtime.verifyPair.mockRejectedValue(new Error('transient rollout failure'))

    await expect(restoreGfsUploadProductMutation(runtime.adapter, lease)).rejects.toThrow(
      'recovery remains required after 3 attempts'
    )
    expect(runtime.applyPair).toHaveBeenCalledTimes(3)
    expect(runtime.adapter.waitBeforeRetry).toHaveBeenCalledTimes(2)
    expect(runtime.getMarker()).toEqual(lease)
    expect(runtime.adapter.deleteMarker).not.toHaveBeenCalled()
  })

  it('fails closed when immutable lease evidence changes', async () => {
    const runtime = fixture()
    const lease = await beginGfsUploadProductMutation(runtime.adapter)
    runtime.setMarker({ ...lease, uid: 'replacement-uid' })

    await expect(applyGfsUploadProductMutation(runtime.adapter, lease, changed)).rejects.toThrow(
      'recovery marker changed'
    )
    expect(runtime.applyPair).not.toHaveBeenCalled()
  })

  it('does not let an unconfirmed second process recover an active lease', async () => {
    const active = fixture(changed)
    const lease = await beginGfsUploadProductMutation(active.adapter)
    const second = fixture(changed)
    second.setMarker(lease)

    await expect(
      recoverGfsUploadProductMutation(second.adapter, {
        uid: lease.uid,
        holder: 'different-holder',
      })
    ).rejects.toThrow('takeover evidence does not match')
    expect(second.applyPair).not.toHaveBeenCalled()
    expect(second.getMarker()).toEqual(lease)
    expect(second.getCurrent()).toEqual(changed)
  })

  it('retains recovery state when the marker is replaced during a long apply', async () => {
    const runtime = fixture()
    const lease = await beginGfsUploadProductMutation(runtime.adapter)
    const replacement = {
      ...lease,
      uid: 'replacement-uid',
      marker: { ...lease.marker, holder: 'replacement-holder' },
    }
    runtime.applyPair.mockImplementationOnce(async () => {
      runtime.setMarker(replacement)
    })
    runtime.verifyPair.mockResolvedValueOnce(undefined)

    await expect(applyGfsUploadProductMutation(runtime.adapter, lease, changed)).rejects.toThrow(
      'recovery marker changed'
    )
    expect(runtime.getMarker()).toEqual(replacement)
    expect(runtime.getMarker()?.marker.baseline).toEqual(baseline)
    await expect(beginGfsUploadProductMutation(runtime.adapter)).rejects.toThrow(
      'recovery is required'
    )
  })

  it('retains recovery state when cluster ownership changes during a long apply', async () => {
    const runtime = fixture()
    const lease = await beginGfsUploadProductMutation(runtime.adapter)
    runtime.authorizeRecovery
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cluster ownership marker was replaced'))

    await expect(applyGfsUploadProductMutation(runtime.adapter, lease, changed)).rejects.toThrow(
      'cluster ownership marker was replaced'
    )
    expect(runtime.getMarker()).toEqual(lease)
    expect(runtime.getMarker()?.marker.baseline).toEqual(baseline)
    await expect(beginGfsUploadProductMutation(runtime.adapter)).rejects.toThrow(
      'recovery is required'
    )
  })

  it('cannot delete a replacement marker after the final lease check', async () => {
    const runtime = fixture(changed)
    const lease = await beginGfsUploadProductMutation(runtime.adapter)
    const replacement = {
      ...lease,
      uid: 'replacement-uid',
      marker: { ...lease.marker, holder: 'replacement-holder' },
    }
    runtime.adapter.deleteMarker = vi.fn(async expected => {
      runtime.setMarker(replacement)
      if (runtime.getMarker()?.uid !== expected.uid) {
        throw new Error('Kubernetes UID precondition failed')
      }
    })

    await expect(restoreGfsUploadProductMutation(runtime.adapter, lease)).rejects.toThrow(
      'recovery remains required'
    )
    expect(runtime.getMarker()).toEqual(replacement)
    expect(runtime.getMarker()?.marker.baseline).toEqual(baseline)
    await expect(beginGfsUploadProductMutation(runtime.adapter)).rejects.toThrow(
      'recovery is required'
    )
  })
})
