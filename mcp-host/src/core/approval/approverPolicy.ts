import { ApprovalResolver } from '../extensions/approvalResolver'
import type { ApprovalConfig } from '../extensions/approvalTypes'

/** Why the approver policy limits a messaging-channel session owner. */
export type ApproverPolicyRefusal = 'policy_cli_only' | 'not_approver' | 'policy_invalid'

/** The owner of a messaging-channel session: its sender and channel type. */
export interface ApprovalSessionOwner {
  /** The sender the session key is built from (`conversation.user_id`). */
  userId: string
  channelType: string
}

const approvalResolver = new ApprovalResolver()

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `defaultPolicy` read as unknown: a dev-mode or ConfigMap policy skips the
 * CRD enum. Unset (absent, null or empty) and `channel_users` are `open`.
 */
function readApproverPolicy(
  config: ApprovalConfig | undefined
): 'open' | 'cli_only' | 'designated_approvers' | 'invalid' {
  if (!config) return 'open'
  const policy: unknown = config.defaultPolicy
  if (policy === undefined || policy === null || policy === '' || policy === 'channel_users') {
    return 'open'
  }
  if (policy === 'cli_only' || policy === 'designated_approvers') return policy
  return 'invalid'
}

/** True when `defaultPolicy` is set to a value the approver policy does not know. */
export function approverPolicyIsInvalid(config: ApprovalConfig | undefined): boolean {
  return readApproverPolicy(config) === 'invalid'
}

/**
 * The config `canUserApprove` reads for a designated-approvers owner, or null
 * to refuse. That function trusts the CRD schema, which a dev-mode or
 * ConfigMap policy skips: an absent `channels` would throw, and a string
 * `approvers` would match by substring, so either shape refuses here, as does
 * a non-boolean `enabled`. An absent `enabled` reads as enabled, the same
 * opt-out rule as an absent channel block. `canUserApprove` reads a missing
 * key as disabled, so the entry is passed with `enabled: true`. Only
 * `enabled: false` refuses a listed approver.
 */
function designatedApproverConfig(
  config: ApprovalConfig,
  channelType: string
): ApprovalConfig | null {
  const channels: unknown = config.channels
  if (!isPlainObject(channels)) return null
  const entry = channels[channelType]
  if (entry === undefined) return config
  if (!isPlainObject(entry)) return null
  const { approvers, enabled } = entry
  if (
    approvers !== undefined &&
    !(Array.isArray(approvers) && approvers.every(approver => typeof approver === 'string'))
  ) {
    return null
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') return null
  if (enabled !== undefined) return config
  return {
    ...config,
    channels: { ...channels, [channelType]: { ...entry, enabled: true } },
  } as ApprovalConfig
}

/**
 * The approver policy for one messaging-channel session owner. It limits who
 * may raise the mode and who keeps a raised mode: the command refuses a raise
 * when this returns a reason, and the channel cap is manual for that owner.
 *
 * Unset (absent, null or empty) and `channel_users` add no check, so the
 * channel switch alone decides. `cli_only` and `designated_approvers` use
 * `canUserApprove`: cli_only refuses every channel owner, and
 * designated_approvers needs the owner in that channel's `approvers`, in a
 * block not set `enabled: false`. Any other value refuses: the CRD enum does
 * not cover a dev-mode or ConfigMap policy. The writer and the config install
 * log that value's field; this function is called on every tool call, so it
 * does not log.
 *
 * Never throws. `canUserApprove` does not read the channel id.
 */
export function approverPolicyRefusal(
  config: ApprovalConfig | undefined,
  owner: ApprovalSessionOwner
): ApproverPolicyRefusal | null {
  const policy = readApproverPolicy(config)
  if (policy === 'open' || !config) return null
  if (policy === 'invalid') return 'policy_invalid'
  const resolved =
    policy === 'cli_only' ? config : designatedApproverConfig(config, owner.channelType)
  // An empty owner is never an approver, even when an `approvers` list holds ''.
  const allowed =
    resolved !== null &&
    owner.userId !== '' &&
    approvalResolver.canUserApprove(owner.userId, owner.channelType, undefined, resolved)
  if (allowed) return null
  return policy === 'cli_only' ? 'policy_cli_only' : 'not_approver'
}
