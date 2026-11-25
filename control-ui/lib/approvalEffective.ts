/**
 * Effective values of an agent's `spec.approval` block. Every comparison the
 * Approvals tab makes (base check, prune check, loosening, display) normalizes
 * through `effectiveApproval` first, so an absent key and its default compare
 * equal. The rules mirror how mcp-host reads the block; the parity test in
 * `__tests__/approvalEffective.parity.test.ts` pins them to its readers.
 */

export type EffectiveChannel = {
  allowModeChange: boolean
  enabled: boolean
  approvers: string[]
}

export type EffectiveApproval = {
  modeCeiling: 'manual' | 'auto' | 'allow_all'
  policy: 'open' | 'cli_only' | 'designated_approvers' | { unknown: string }
  channels: Record<'telegram' | 'email' | 'slack' | 'teams', EffectiveChannel>
  tools: Record<string, boolean>
  /** null is the code default (absent or blank). */
  shellClassifierModel: string | null
}

const CHANNEL_TYPES = ['telegram', 'email', 'slack', 'teams'] as const

/**
 * `allowModeChange` when absent. Email identity is the From address, which a
 * sender can forge, so email raises only on an explicit true. Pinned to
 * mcp-host's `readChannelSwitch` by the parity test.
 */
const CHANNEL_SWITCH_DEFAULT: Record<(typeof CHANNEL_TYPES)[number], boolean> = {
  telegram: true,
  email: false,
  slack: true,
  teams: true,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A Host's `spec.approval`, as mcp-host reads it (`host.spec.approval ||
 * CLERUM_APPROVAL_CONFIG`): absent, null, or not an object is no block (the
 * agent inherits); `{}` is a block of its own. The save protocol and the
 * Approvals tab's display state both read the block through this, so they
 * agree on what a block is.
 */
export function approvalBlockOf(host: unknown): Record<string, unknown> | undefined {
  const spec = isPlainObject(host) ? host.spec : undefined
  const block = isPlainObject(spec) ? spec.approval : undefined
  return isPlainObject(block) ? block : undefined
}

function readPolicy(value: unknown): EffectiveApproval['policy'] {
  if (value === undefined || value === null || value === '' || value === 'channel_users') {
    return 'open'
  }
  if (value === 'cli_only' || value === 'designated_approvers') return value
  // An unknown policy refuses like cli_only; keep the raw value for display.
  return { unknown: typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)) }
}

function readChannel(channels: unknown, type: (typeof CHANNEL_TYPES)[number]): EffectiveChannel {
  // A malformed value (non-object channels or entry, non-boolean field) is
  // what mcp-host refuses or caps at manual, so it reads as off / no approvers.
  if (channels !== undefined && !isPlainObject(channels)) {
    return { allowModeChange: false, enabled: false, approvers: [] }
  }
  const entry = channels?.[type]
  if (entry === undefined) {
    return { allowModeChange: CHANNEL_SWITCH_DEFAULT[type], enabled: true, approvers: [] }
  }
  if (!isPlainObject(entry)) {
    return { allowModeChange: false, enabled: false, approvers: [] }
  }
  const { allowModeChange, enabled, approvers } = entry
  const approversValid =
    approvers === undefined ||
    (Array.isArray(approvers) && approvers.every(a => typeof a === 'string'))
  return {
    allowModeChange:
      allowModeChange === undefined ? CHANNEL_SWITCH_DEFAULT[type] : allowModeChange === true,
    enabled: enabled === undefined ? true : enabled === true,
    // Exact strings: never trimmed. Deduplicated and sorted to compare as a set.
    approvers:
      approversValid && Array.isArray(approvers) ? [...new Set(approvers as string[])].sort() : [],
  }
}

/** Booleans stay as stored; absent and null stay absent. */
function readTools(tools: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!isPlainObject(tools)) return out
  for (const [name, value] of Object.entries(tools)) {
    if (typeof value === 'boolean') out[name] = value
  }
  return out
}

export function effectiveApproval(
  block: Record<string, unknown> | null | undefined
): EffectiveApproval {
  const b = isPlainObject(block) ? block : {}
  const ceiling = b.modeCeiling
  const model = b.shellClassifierModel
  const channels = {} as EffectiveApproval['channels']
  for (const type of CHANNEL_TYPES) channels[type] = readChannel(b.channels, type)
  return {
    modeCeiling: ceiling === 'auto' || ceiling === 'allow_all' ? ceiling : 'manual',
    policy: readPolicy(b.defaultPolicy),
    channels,
    tools: readTools(b.tools),
    shellClassifierModel:
      typeof model === 'string' && model.trim().length > 0 ? model.trim() : null,
  }
}

/**
 * Three-valued: absent, true and false are distinct. Equal when the key sets
 * and values match. `null` reads as absent, as the gate's `override ?? default`
 * does. Any other non-boolean value (outside the CRD schema) is its own value,
 * equal only to itself: the gate treats it as neither true, false nor absent,
 * and calling it a change is the safe side for loosening.
 */
export function toolsEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): boolean {
  const present = (m: Record<string, unknown> | undefined): Map<string, unknown> =>
    new Map(Object.entries(m ?? {}).filter(([, v]) => v !== null && v !== undefined))
  const ma = present(a)
  const mb = present(b)
  if (ma.size !== mb.size) return false
  for (const [k, v] of ma) {
    if (!mb.has(k) || !Object.is(mb.get(k), v)) return false
  }
  return true
}
