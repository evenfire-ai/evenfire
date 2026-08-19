import type { GuardrailBuiltinType, GuardrailPhase } from './types'

// Render/iteration order for the hook phases.
export const GUARDRAIL_PHASES: readonly GuardrailPhase[] = [
  'preToolUse',
  'preCall',
  'moderate',
  'postCallSuccess',
  'postToolUse',
  'onError',
] as const

export const GUARDRAIL_PHASE_LABELS: Record<GuardrailPhase, string> = {
  preToolUse: 'Pre-tool use',
  postToolUse: 'Post-tool use',
  preCall: 'Pre-call',
  moderate: 'Moderate',
  postCallSuccess: 'Post-call success',
  onError: 'On error',
}

// Curated built-in types offered by the minimal add UI.
export const GUARDRAIL_BUILTIN_OPTIONS: ReadonlyArray<{
  value: GuardrailBuiltinType
  label: string
}> = [
  { value: 'prompt-shaping', label: 'Prompt shaping' },
  { value: 'token-trim', label: 'Token trim' },
] as const
