import { GUARDRAIL_ENTRY_TYPE } from '@constants/marketplaceEntryTypes'
import { CONTROL_ROUTES } from '@constants/routes'
import type { GuardrailPhase } from './types'

// Guardrail hooks are Marketplace entries; keep the chooser scoped to that
// type so regular connectors and plugins do not appear as install candidates.
export const GUARDRAIL_MARKETPLACE_ROUTE = CONTROL_ROUTES.marketplace.orgEntriesFiltered({
  type: GUARDRAIL_ENTRY_TYPE,
})

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
