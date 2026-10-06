import { describe, expect, it } from 'vitest'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import type { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import type { GfsProcessingLeaseProvider } from '../../internalTools/gfsProcessingLease'
import {
  gfsManagedWorkspaceExecution,
  gfsWorkspaceExecutionEnabled,
} from '../gfsExecutionCapability'

const approvalConfig: ApprovalConfig = {
  defaultPolicy: 'channel_users',
  channels: {},
}
const leases: GfsProcessingLeaseProvider = {
  acquireProcessingLease: async () => ({
    leaseId: 'lease-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  releaseProcessingLease: async () => undefined,
}

function input(overrides?: Partial<Parameters<typeof gfsWorkspaceExecutionEnabled>[0]>) {
  return {
    approvalEnabled: true,
    source: 'channel' as const,
    callerIdentity: 'caller-1',
    store: { isAvailable: () => true } as GfsDownloadStore,
    callerWorkspacePath: '/workspace/users/caller-1',
    processingLeaseProvider: leases,
    approvalConfig,
    retentionOwnerId: 'task-owner',
    ...overrides,
  }
}

describe('gfsWorkspaceExecutionEnabled', () => {
  it('enables the caller-bound workspace lane on an attended live-approval surface', () => {
    expect(gfsWorkspaceExecutionEnabled(input())).toBe(true)
    expect(
      gfsWorkspaceExecutionEnabled(
        input({
          approvalConfig: { ...approvalConfig, tools: { shell_exec: true } },
        })
      )
    ).toBe(true)
  })

  it('rejects delivery while the Host store is in recovery-required state', () => {
    expect(
      gfsWorkspaceExecutionEnabled(
        input({
          store: {
            isAvailable: () => false,
          } as GfsDownloadStore,
        })
      )
    ).toBe(false)
  })

  it.each([
    ['approval disabled', { approvalEnabled: false }],
    ['cron source', { source: 'cron' as const }],
    ['internal source', { source: 'internal' as const }],
    [
      'shell tool disabled',
      { approvalConfig: { ...approvalConfig, tools: { shell_exec: false } } },
    ],
    ['missing caller identity', { callerIdentity: undefined }],
    ['missing Host store', { store: undefined }],
    ['missing caller workspace', { callerWorkspacePath: undefined }],
    ['missing processing lease provider', { processingLeaseProvider: undefined }],
    ['missing task retention owner', { retentionOwnerId: undefined }],
  ])('rejects %s', (_name, overrides) => {
    expect(gfsWorkspaceExecutionEnabled(input(overrides))).toBe(false)
  })
})

describe('store-associated executable workspace', () => {
  it.each([
    ['approval disabled', { approvalEnabled: false }],
    ['cron source', { source: 'cron' as const }],
    ['internal source', { source: 'internal' as const }],
    [
      'shell consent disabled',
      { approvalConfig: { ...approvalConfig, tools: { shell_exec: false } } },
    ],
    ['missing caller root', { callerWorkspacePath: undefined }],
    ['missing delivery owner', { retentionOwnerId: undefined }],
  ])('keeps processing lease protection for %s', (_name, overrides) => {
    expect(gfsManagedWorkspaceExecution(input(overrides))?.processingLeaseProvider).toBe(leases)
  })

  it('derives a store-bound provider when none was supplied instead of dropping protection', () => {
    const store = {
      isAvailable: () => false,
      processingLeaseProvider: () => leases,
    } as unknown as GfsDownloadStore
    const managed = gfsManagedWorkspaceExecution(
      input({ store, processingLeaseProvider: undefined })
    )
    expect(managed).toMatchObject({ processingLeaseProvider: leases, deliveryAvailable: false })
    expect(managed?.store).toBeUndefined()
  })

  it('uses the system admission identity while keeping absent caller roots unavailable', () => {
    const managed = gfsManagedWorkspaceExecution(
      input({
        callerIdentity: undefined,
        callerWorkspacePath: undefined,
      })
    )
    expect(managed?.callerIdentity).toBe('_system')
    expect(managed?.callerWorkspacePath).toBeUndefined()
  })
})
