import type { ApprovalConfig } from '../core/extensions/approvalTypes'
import type { GfsDownloadStore } from '../internalTools/gfsDownloadStore'
import type { GfsProcessingLeaseProvider } from '../internalTools/gfsProcessingLease'
import type { TaskSource } from '../queue/types'

export interface GfsExecutionCapabilityInput {
  approvalEnabled: boolean
  source: TaskSource
  callerIdentity: string | undefined
  store: GfsDownloadStore | undefined
  callerWorkspacePath: string | undefined
  processingLeaseProvider: GfsProcessingLeaseProvider | undefined
  approvalConfig: ApprovalConfig | undefined
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
  processingLeaseProvider: GfsProcessingLeaseProvider
} {
  return Boolean(
    input.approvalEnabled &&
    input.source === 'channel' &&
    input.callerIdentity &&
    input.store &&
    input.callerWorkspacePath &&
    input.processingLeaseProvider &&
    input.approvalConfig?.tools?.shell_exec !== false
  )
}
