import type { ApprovalConfig } from '../extensions/approvalTypes'

/**
 * Stored approval mode. Rank is manual < auto < allow_all.
 * The messaging command spells the top value `allow-all`; stored JSON uses `allow_all`.
 */
export type ApprovalMode = 'manual' | 'auto' | 'allow_all'

/**
 * Live approval config split by source.
 *
 * `effective` is `host.spec.approval || CLERUM_APPROVAL_CONFIG`, as today.
 * `hostSpec` is `host.spec.approval` alone. In dev mode, main passes
 * `config.approvalConfig` as `hostSpec`. Ceiling and channel cap read
 * `hostSpec` only.
 */
export interface ApprovalConfigSnapshot {
  effective: ApprovalConfig | undefined
  hostSpec: ApprovalConfig | undefined
}

const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = {
  manual: 0,
  auto: 1,
  allow_all: 2,
}

const APPROVAL_MODES_BY_RANK: readonly ApprovalMode[] = ['manual', 'auto', 'allow_all']

const APPROVAL_MODE_COMMANDS: Readonly<Record<string, ApprovalMode>> = {
  'approval-mode manual': 'manual',
  'approval-mode auto': 'auto',
  'approval-mode allow-all': 'allow_all',
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Unknown, missing, and non-enum values are manual. */
export function normalizeApprovalMode(value: unknown): ApprovalMode {
  if (value === 'manual' || value === 'auto' || value === 'allow_all') return value
  return 'manual'
}

/** Ceiling from `hostSpec` only. An env-only policy is manual. */
export function readModeCeiling(snapshot: ApprovalConfigSnapshot): ApprovalMode {
  return normalizeApprovalMode(snapshot.hostSpec?.modeCeiling)
}

const MESSAGING_CHANNEL_TYPES = ['telegram', 'email', 'slack', 'teams'] as const
type MessagingChannelType = (typeof MESSAGING_CHANNEL_TYPES)[number]

/**
 * The channel switch when `allowModeChange` is absent. Email identity is the
 * From address, which a sender can forge, so email raises only on an explicit
 * `true`. The other messaging channels default to on.
 */
const CHANNEL_SWITCH_DEFAULT: Record<MessagingChannelType, boolean> = {
  telegram: true,
  email: false,
  slack: true,
  teams: true,
}

function isMessagingChannelType(value: string | undefined): value is MessagingChannelType {
  return (MESSAGING_CHANNEL_TYPES as readonly (string | undefined)[]).includes(value)
}

/**
 * Channel cap from `hostSpec` only.
 * `rpc` is allow_all. telegram, slack, and teams are allow_all unless
 * `allowModeChange` is `false`; email is allow_all only when it is `true`.
 * An absent `channels`, channel block, or field takes that default. A value
 * that is present but malformed (a non-object `channels` or entry, or a
 * non-boolean field) caps the channel at manual; `approvalModeConfigWarnings`
 * names it. Every other channel type is manual.
 */
export function readChannelCap(
  snapshot: ApprovalConfigSnapshot,
  channelType: string | undefined
): ApprovalMode {
  if (channelType === 'rpc') return 'allow_all'
  if (!isMessagingChannelType(channelType)) return 'manual'

  // The declared types are objects and booleans, but a spec that skipped the
  // apiserver schema (dev-mode env config) can carry anything. Read as unknown.
  const channels: unknown = snapshot.hostSpec?.channels
  let allowModeChange: unknown
  if (channels !== undefined) {
    if (!isPlainObject(channels)) return 'manual'
    const entry = channels[channelType]
    if (entry !== undefined) {
      if (!isPlainObject(entry)) return 'manual'
      allowModeChange = entry.allowModeChange
    }
  }
  if (allowModeChange === undefined) allowModeChange = CHANNEL_SWITCH_DEFAULT[channelType]
  return allowModeChange === true ? 'allow_all' : 'manual'
}

/** One malformed approval-mode field. `field` is a path under `spec.approval`. */
export interface ApprovalModeConfigWarning {
  field: string
  message: string
}

/**
 * Malformed mode fields in a Host's `spec.approval`. Each one reads manual.
 * Called once per config install so an operator can see why a channel or the
 * ceiling stayed manual. Messages name the field, never its value.
 */
export function approvalModeConfigWarnings(
  approval: ApprovalConfig | undefined
): ApprovalModeConfigWarning[] {
  if (!isPlainObject(approval)) return []
  const warnings: ApprovalModeConfigWarning[] = []
  const ceiling = approval.modeCeiling
  if (
    Object.hasOwn(approval, 'modeCeiling') &&
    ceiling !== undefined &&
    normalizeApprovalMode(ceiling) !== ceiling
  ) {
    warnings.push({
      field: 'modeCeiling',
      message: 'modeCeiling is not manual, auto or allow_all; the ceiling reads manual',
    })
  }
  const channels: unknown = approval.channels
  if (channels === undefined) return warnings
  if (!isPlainObject(channels)) {
    warnings.push({
      field: 'channels',
      message: 'channels is not an object; every messaging channel is capped at manual',
    })
    return warnings
  }
  for (const channelType of MESSAGING_CHANNEL_TYPES) {
    const entry = channels[channelType]
    if (entry === undefined) continue
    if (!isPlainObject(entry)) {
      warnings.push({
        field: `channels.${channelType}`,
        message: `channels.${channelType} is not an object; that channel is capped at manual`,
      })
      continue
    }
    const value = entry.allowModeChange
    if (value !== undefined && typeof value !== 'boolean') {
      warnings.push({
        field: `channels.${channelType}.allowModeChange`,
        message: `channels.${channelType}.allowModeChange is not a boolean; that channel is capped at manual`,
      })
    }
  }
  return warnings
}

/** Effective mode is min(stored, ceiling, channel cap). */
export function effectiveApprovalMode(
  stored: ApprovalMode,
  ceiling: ApprovalMode,
  cap: ApprovalMode
): ApprovalMode {
  const rank = Math.min(
    APPROVAL_MODE_RANK[stored],
    APPROVAL_MODE_RANK[ceiling],
    APPROVAL_MODE_RANK[cap]
  )
  return APPROVAL_MODES_BY_RANK[rank]
}

/**
 * The whole trimmed message, case-insensitive, must be `approval-mode manual`,
 * `approval-mode auto`, or `approval-mode allow-all`. Anything else is not a command.
 */
export function parseApprovalModeCommand(text: string): ApprovalMode | null {
  const key = text.trim().toLowerCase()
  if (!Object.hasOwn(APPROVAL_MODE_COMMANDS, key)) return null
  return APPROVAL_MODE_COMMANDS[key]
}
