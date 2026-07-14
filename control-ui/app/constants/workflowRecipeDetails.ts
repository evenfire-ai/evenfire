export const WORKFLOW_RECIPE_DEFAULT_DETAIL_TAB = 'workloads'

export const WORKFLOW_RECIPE_DETAIL_TABS = [
  'workloads',
  'runs',
  'conditions',
  'secrets',
  'integrations',
  'members',
  'teams',
  'approval-targets',
] as const

export type WorkflowRecipeDetailTab = (typeof WORKFLOW_RECIPE_DETAIL_TABS)[number]
