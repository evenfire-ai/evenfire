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

// Default installation order applied by the backend when none is supplied.
export const DEFAULT_HOOK_ORDER = 100

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
