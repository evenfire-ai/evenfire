export const GUARDRAIL_DEFAULT_TAB = 'details'

export const GUARDRAIL_DETAIL_TABS = ['details', 'agents'] as const

export type GuardrailTab = (typeof GUARDRAIL_DETAIL_TABS)[number]

export const GUARDRAIL_TAB_LABELS: Record<GuardrailTab, string> = {
  details: 'Details',
  agents: 'Agents with access',
}
