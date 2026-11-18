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

/**
 * Channel cap from `hostSpec` only.
 * `rpc` is allow_all. telegram, email, and slack are allow_all only when
 * `allowModeChange` is not `false`. The switch defaults to on: a missing
 * channel block, or a block that omits the field, still allows the raise.
 * Only an explicit `false` caps that channel at manual. Every other channel
 * type is manual. A missing or non-object `channels` value does not throw.
 */
export function readChannelCap(
  snapshot: ApprovalConfigSnapshot,
  channelType: string | undefined
): ApprovalMode {
  if (channelType === 'rpc') return 'allow_all'
  if (
    channelType !== 'telegram' &&
    channelType !== 'email' &&
    channelType !== 'slack' &&
    channelType !== 'teams'
  ) {
    return 'manual'
  }

  // The declared channels type is an object, but a live spec can be null or
  // a non-object. Read it as unknown so that case returns manual instead of throwing.
  const channels: unknown = snapshot.hostSpec?.channels
  if (!isPlainObject(channels)) return 'allow_all'

  const entry = channels[channelType]
  if (!isPlainObject(entry)) return 'allow_all'
  return entry.allowModeChange === false ? 'manual' : 'allow_all'
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
