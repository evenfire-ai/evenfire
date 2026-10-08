import type { ApprovalConfig } from '../core/extensions/approvalTypes'
import type { GfsDownloadStore } from '../internalTools/gfsDownloadStore'
import type { TaskSource } from '../queue/types'
import type { IncomingMessage } from '../server/types'
import { deriveUserKeyFromSource } from '../workspace/userKey'

export interface GfsManagedWorkspaceExecution {
  /** Trusted task/caller identity for store admission; system tasks use the existing `_system` namespace. */
  callerIdentity: string
  /** Present only while durable delivery is healthy. */
  store?: GfsDownloadStore
  /** Undefined only when no trusted caller root can be derived; shell must then fail closed. */
  callerWorkspacePath?: string
  retentionOwnerId?: string
  deliveryAvailable: boolean
}

export const GFS_SYSTEM_CALLER_IDENTITY = '_system'

/**
 * The download store's caller identity for a task: the channel-namespaced key
 * that also names the caller root `users/<key>`. The raw sender is not unique
 * across channels, so keying the store by it would let two humans with the
 * same sender on different channels share reuse, managed reads and pins while
 * their copies live in different roots. Tasks with no source message get the
 * `_system` key, the same as their caller root.
 */
export function gfsStoreCallerIdentity(
  sourceMessage?: Pick<IncomingMessage, 'sender' | 'channelType'> | null
): string {
  return deriveUserKeyFromSource(sourceMessage)
}

export interface GfsExecutionCapabilityInput {
  approvalEnabled: boolean
  source: TaskSource
  callerIdentity: string | undefined
  store: GfsDownloadStore | undefined
  callerWorkspacePath: string | undefined
  approvalConfig: ApprovalConfig | undefined
  retentionOwnerId?: string
}

/**
 * GFS workspace delivery requires an attended channel caller, live approval,
 * an explicit shell tool policy, and the Host-owned caller-bound store/root.
 * Cron and internal tasks stay unattended; persistent approvals are handled at
 * the live shell controller boundary, not by this static capability check.
 */
export function gfsWorkspaceExecutionEnabled(
  input: GfsExecutionCapabilityInput
): input is GfsExecutionCapabilityInput & {
  callerIdentity: string
  store: GfsDownloadStore
  callerWorkspacePath: string
} {
  return Boolean(
    input.approvalEnabled &&
    input.source === 'channel' &&
    input.callerIdentity &&
    input.store?.isAvailable() &&
    input.callerWorkspacePath &&
    input.retentionOwnerId &&
    input.approvalConfig?.tools?.shell_exec !== false
  )
}

/**
 * Associate every executable registry with the Host GFS store independently of
 * download eligibility. Shell never falls back to the shared Host root while a
 * store exists and fails closed without a caller root. Shell never calls the
 * store (#1019), so an unavailable store only disables delivery.
 */
export function gfsManagedWorkspaceExecution(
  input: GfsExecutionCapabilityInput
): GfsManagedWorkspaceExecution | undefined {
  if (!input.store) return undefined
  const callerIdentity = input.callerIdentity ?? GFS_SYSTEM_CALLER_IDENTITY
  const storeAvailable = input.store.isAvailable()
  return {
    callerIdentity,
    store: storeAvailable ? input.store : undefined,
    callerWorkspacePath: input.callerWorkspacePath,
    retentionOwnerId: input.retentionOwnerId,
    deliveryAvailable: storeAvailable,
  }
}
