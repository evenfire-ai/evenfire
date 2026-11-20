import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { HostCRD } from '../../../types'
import type { ApprovalConfig } from '../../extensions/approvalTypes'
import { readChannelCap, readModeCeiling } from '../approvalMode'
import type { ApprovalConfigSnapshot } from '../approvalMode'
import { applyHostChange } from '../hostChange'
import { createHostEventGate } from '../hostEventGate'

function host(name: string, approval: ApprovalConfig): HostCRD {
  return {
    name,
    namespace: 'ns',
    spec: { host: name, contextRef: 'ctx', approval },
  }
}

function policy(ceiling: 'manual' | 'allow_all', allowModeChange: boolean): ApprovalConfig {
  return {
    defaultPolicy: 'channel_users',
    modeCeiling: ceiling,
    channels: { slack: { enabled: true, allowModeChange } },
  }
}

async function race(e1Approval: ApprovalConfig, e2Approval: ApprovalConfig) {
  const gate = createHostEventGate()
  let currentHost: HostCRD | null = null
  let snapshot: ApprovalConfigSnapshot = { effective: undefined, hostSpec: undefined }
  const setApprovalConfig = vi.fn(
    (config: ApprovalConfig | undefined, hostSpec?: ApprovalConfig) => {
      snapshot = { effective: config, hostSpec }
    }
  )
  const releases: Array<() => void> = []
  const ensureConfigStore = vi.fn(
    () =>
      new Promise<void>(resolve => {
        releases.push(resolve)
      })
  )
  const commitHost = vi.fn((next: HostCRD) => {
    currentHost = next
    setApprovalConfig(next.spec.approval, next.spec.approval)
  })
  const publishApproval = vi.fn((next: HostCRD) => {
    setApprovalConfig(next.spec.approval, next.spec.approval)
  })
  const e1 = host('e1', e1Approval)
  const e2 = host('e2', e2Approval)
  const first = applyHostChange(e1, { gate, publishApproval, ensureConfigStore, commitHost })
  const second = applyHostChange(e2, { gate, publishApproval, ensureConfigStore, commitHost })
  expect(releases).toHaveLength(2)
  releases[1]!()
  await second
  const callsAfterE2 = setApprovalConfig.mock.calls.length
  releases[0]!()
  await first
  return {
    e1,
    e2,
    currentHost,
    snapshot,
    setApprovalConfig,
    callsAfterE2,
    commitHost,
    publishApproval,
    ensureConfigStore,
  }
}

describe('applyHostChange', () => {
  it('keeps the newer ceiling when an older host event finishes last', async () => {
    const raced = await race(policy('allow_all', true), policy('manual', true))

    expect(readModeCeiling(raced.snapshot)).toBe('manual')
    expect(raced.currentHost).toBe(raced.e2)
    expect(raced.commitHost.mock.calls.map(call => call[0])).toEqual([raced.e2])
    expect(raced.setApprovalConfig.mock.calls.length).toBe(raced.callsAfterE2)
    expect(raced.publishApproval).toHaveBeenCalledWith(raced.e1)
    expect(raced.publishApproval).toHaveBeenCalledWith(raced.e2)
    expect(raced.publishApproval.mock.invocationCallOrder[0]).toBeLessThan(
      raced.ensureConfigStore.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('keeps a channel cap at manual when a newer event turns allowModeChange off', async () => {
    const raced = await race(policy('allow_all', true), policy('allow_all', false))

    expect(readModeCeiling(raced.snapshot)).toBe('allow_all')
    expect(readChannelCap(raced.snapshot, 'slack')).toBe('manual')
    expect(raced.currentHost).toBe(raced.e2)
    expect(raced.commitHost.mock.calls.map(call => call[0])).toEqual([raced.e2])
    expect(raced.setApprovalConfig.mock.calls.length).toBe(raced.callsAfterE2)
  })

  // Compile-time: `npx tsc --noEmit` fails here if commitHost is typed `void`,
  // which would let an async implementation's rejection fall outside the type.
  it('types commitHost as sync or async', () => {
    type CommitHost = Parameters<typeof applyHostChange>[1]['commitHost']
    expectTypeOf<ReturnType<CommitHost>>().toEqualTypeOf<void | Promise<void>>()
  })

  it('rejects when an async commitHost rejects', async () => {
    const failure = new Error('fixture commit failure')
    const commitHost: Parameters<typeof applyHostChange>[1]['commitHost'] = vi.fn(async () => {
      throw failure
    })
    const ensureConfigStore = vi.fn(async () => undefined)

    await expect(
      applyHostChange(host('e1', policy('manual', true)), {
        gate: createHostEventGate(),
        publishApproval: vi.fn(),
        ensureConfigStore,
        commitHost,
      })
    ).rejects.toBe(failure)
    expect(ensureConfigStore).toHaveBeenCalledTimes(1)
    expect(commitHost).toHaveBeenCalledTimes(1)
  })
})
