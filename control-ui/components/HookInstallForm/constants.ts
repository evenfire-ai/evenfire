import type { HookCapability } from '@lib/api'

// The four guardrail-hook capabilities the backend accepts. A hook's selected
// capabilities must be a subset of the target Host's guardrails.capabilityCeiling.
export const HOOK_CAPABILITY_OPTIONS: Array<{
  value: HookCapability
  label: string
  description: string
}> = [
  {
    value: 'may_deny',
    label: 'May deny',
    description: 'Block the call or response. Requires fail-closed mode.',
  },
  {
    value: 'may_rewrite',
    label: 'May rewrite',
    description: 'Modify the prompt or tool input before it proceeds.',
  },
  {
    value: 'may_substitute_result',
    label: 'May substitute result',
    description: 'Replace the tool or model result.',
  },
  {
    value: 'may_add_context',
    label: 'May add context',
    description: 'Append additional context to the call.',
  },
]

export const ALL_HOOK_CAPABILITIES: HookCapability[] = HOOK_CAPABILITY_OPTIONS.map(o => o.value)

// The capabilities mcp-host neutralizes when they are not granted, per
// `enforceCapabilities` (core/guardrails/capabilities.ts): an ungranted `deny`
// downgrades to `no_decision`, an ungranted `rewrite`/`substitute` is dropped.
//
// `may_add_context` has no such branch — a hook adds context whether or not it
// was granted — so telling an operator its actions are discarded would be
// untrue for that one, and would spend the warning's credibility on a case
// where nothing is wrong.
export const ENFORCED_HOOK_CAPABILITIES: HookCapability[] = [
  'may_deny',
  'may_rewrite',
  'may_substitute_result',
]

// Default installation order applied by the backend when none is supplied.
export const DEFAULT_HOOK_ORDER = 100

// `hook_meta.authorDefaults.orderHint` is a word ("early", "late"), while the
// CRD's `order` is an integer. There is no published mapping between them, so
// the hint is shown to the operator rather than silently converted to a number.
//
// Null-prototype on purpose: the key is a publisher-supplied string off the
// registry entry, so an inherited key (`toString`, `constructor`, …) would
// otherwise resolve to a function and be rendered as if it were a real hint.
export const ORDER_HINT_LABELS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    early: 'The author suggests running this hook early.',
    late: 'The author suggests running this hook late.',
  }
)

// Friendly copy for the coded error bodies the install-hook route returns
// ({ error, reason? }). Any reason string from the backend is appended verbatim.
export const HOOK_INSTALL_ERROR_LABELS: Record<string, string> = {
  hook_below_trust_floor: "This hook is below the agent's minimum installed-hook trust level.",
  content_egress_requires_high_trust:
    'Hooks that egress content require a high-trust registry entry (§8.4).',
  capability_exceeds_ceiling: "A selected capability exceeds the agent's capability ceiling.",
  deny_requires_fail_closed: 'A hook that may deny must run in fail-closed mode.',
  image_not_allowlisted: "This hook's image is not allow-listed for installation.",
  unknown_credential_keys: 'One or more credential keys are not recognized by this hook.',
}
