import { describe, expect, it } from 'vitest'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import type { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import type { GfsProcessingLeaseProvider } from '../../internalTools/gfsProcessingLease'
import { gfsWorkspaceExecutionEnabled } from '../gfsExecutionCapability'

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
    store: {} as GfsDownloadStore,
    callerWorkspacePath: '/workspace/users/caller-1',
    processingLeaseProvider: leases,
    approvalConfig,
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
  ])('rejects %s', (_name, overrides) => {
    expect(gfsWorkspaceExecutionEnabled(input(overrides))).toBe(false)
  })
})
