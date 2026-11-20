/**
 * Approval permission types for the tool approval system.
 *
 * Phase 6: Defines the hierarchical permission model:
 *   Host CRD (approval config)
 *     -> Channel-level permission (telegram/email/slack/teams)
 *       -> Per-user approval permission
 */
import type { ShellAction } from '../approval/shellCard'

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
  /**
   * When true, a telegram, email, slack, or teams session may use a channel
   * cap of allow_all. Every other channel stays manual. Absent is false.
   */
  allowModeChange?: boolean
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
  /**
   * Ceiling for a stored approval mode. Readers accept only manual, auto, and
   * allow_all; an absent or any other value is manual.
   */
  modeCeiling?: string
  /**
   * Model the dedicated shell classifier calls when this Host has an OpenAI
   * credential. Absent or blank means gpt-5.5. A model the classifier does
   * not allow shows the shell card. With no OpenAI credential, auto keeps
   * the model serving the turn.
   */
  shellClassifierModel?: string
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
  /** Present only for an approve whose body named once, command, or shell. */
  shellAction?: ShellAction
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
  shellAction?: ShellAction
}
