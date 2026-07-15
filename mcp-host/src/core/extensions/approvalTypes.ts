/**
 * Approval permission types for the tool approval system.
 *
 * Phase 6: Defines the hierarchical permission model:
 *   Host CRD (approval config)
 *     -> Channel-level permission (telegram/email/slack/teams)
 *       -> Per-user approval permission
 */

// ─── Approval Policy ───────────────────────────────────────

/**
 * Defines who can approve tool calls.
 *
 * - cli_only: Only HTTP /approve /deny endpoints work. No channel users.
 * - channel_users: Any authorized user (from CommunicationChannel CRD) can approve.
 * - designated_approvers: Only users in approval.channels.<type>.approvers[].
 */
export type ApprovalPolicy = 'cli_only' | 'channel_users' | 'designated_approvers'

// ─── Channel Approval Config ───────────────────────────────

/**
 * Per-channel-type approval configuration.
 *
 * enabled: Master switch for this channel type. If false, no users
 *          in this channel can approve regardless of other settings.
 * approvers: List of user IDs allowed to approve (used with designated_approvers policy).
 */
export interface ChannelApprovalConfig {
  enabled: boolean
  approvers?: string[]
}

// ─── Approval Config ───────────────────────────────────────

/**
 * Top-level approval configuration, stored in Host CRD spec.approval.
 */
export interface ApprovalConfig {
  defaultPolicy: ApprovalPolicy
  channels: Partial<Record<'telegram' | 'email' | 'slack' | 'teams', ChannelApprovalConfig>>
  /**
   * Per-tool approval overrides for native tools. Key = native tool name
   * (e.g. "http_request", "shell_exec"). Value:
   *   - true  → force approval even if tool.requiresApproval() returns false
   *   - false → skip approval even if tool.requiresApproval() returns true
   * Absent key → fall through to the tool class's own requiresApproval().
   *
   * Out of scope for v1: MCP tools (gated separately by serverName__toolName).
   */
  tools?: Record<string, boolean>
}

// ─── Approval Decision ─────────────────────────────────────

/**
 * An approval or denial decision from a user.
 * Sent via POST /approve or POST /deny.
 */
export interface ApprovalDecision {
  userId: string
  requestId: string
  approved: boolean
  alwaysApprove: boolean
  channelType?: string
  channelId?: string
}

// ─── Approval Request (HTTP body) ──────────────────────────

/**
 * HTTP request body for /approve and /deny endpoints.
 */
export interface ApprovalRequest {
  userId: string
  requestId: string
  alwaysApprove?: boolean
  channelType?: string
  channelId?: string
}
