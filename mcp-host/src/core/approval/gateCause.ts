import type { ToolCall } from '../types'
import type { ApprovalMode } from './approvalMode'
import type { ShellVerdict } from './shellClassifier'

/** Why a gate suspended, or `none` when no card is needed. */
export type GateCause =
  | 'none'
  | 'ordinary'
  | 'admin_forced'
  | 'cron_forced'
  | 'live'
  | 'denied'
  | 'denials_active'
  | 'guardrail_ask'

/**
 * Live inputs for a later decision. Getters are read at admission time.
 * This task only threads them; it does not apply the decision table.
 */
export interface ApprovalModeInputs {
  storedMode(): ApprovalMode
  ceiling(): ApprovalMode
  channelCap(): ApprovalMode
  classifierAvailable(args: Record<string, unknown>): boolean
  classify(call: ToolCall, description: string): Promise<ShellVerdict>
}
