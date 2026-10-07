import { describe, expect, it } from 'vitest'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import type { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import {
  gfsManagedWorkspaceExecution,
  gfsWorkspaceExecutionEnabled,
} from '../gfsExecutionCapability'

const approvalConfig: ApprovalConfig = {
  defaultPolicy: 'channel_users',
  channels: {},
}

function input(overrides?: Partial<Parameters<typeof gfsWorkspaceExecutionEnabled>[0]>) {
  return {
    approvalEnabled: true,
    source: 'channel' as const,
    callerIdentity: 'caller-1',
    store: { isAvailable: () => true } as GfsDownloadStore,
    callerWorkspacePath: '/workspace/users/caller-1',
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
    ['missing delivery owner', { retentionOwnerId: undefined }],
  ])('keeps the store-bound caller root for %s', (_name, overrides) => {
    expect(gfsManagedWorkspaceExecution(input(overrides))).toMatchObject({
      callerIdentity: 'caller-1',
      callerWorkspacePath: '/workspace/users/caller-1',
    })
  })

  it('keeps the caller root and only disables delivery while the store is unavailable', () => {
    const touched: string[] = []
    // Every store member other than isAvailable() records its access: managed
    // execution must not depend on any other store operation (#1019).
    const store = new Proxy({} as GfsDownloadStore, {
      get(_target, property) {
        touched.push(String(property))
        if (property === 'isAvailable') return () => false
        return undefined
      },
    })
    const managed = gfsManagedWorkspaceExecution(input({ store }))
    expect(managed).toMatchObject({
      callerIdentity: 'caller-1',
      callerWorkspacePath: '/workspace/users/caller-1',
      deliveryAvailable: false,
    })
    expect(managed?.store).toBeUndefined()
    // Witness: the availability probe ran; nothing else on the store was read.
    expect(touched).toEqual(['isAvailable'])
    expect(
      gfsWorkspaceExecutionEnabled(
        input({ store: managed?.store, callerWorkspacePath: managed?.callerWorkspacePath })
      )
    ).toBe(false)
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
