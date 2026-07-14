import type { AccessContractKey } from '@components/WorkflowAccessPanel/types'

export type RecipeStatusContentProps = {
  /** Parent recipe name (the user-installed template). */
  name: string
  /** Recipe namespace. */
  namespace: string
  /**
   * If set, this view is bound to a specific run — workflow-recipes spawns a
   * child WorkflowRecipe per WorkflowRun row, named `<parent>-<runId.slice(0,8)>`
   * (see workflow-recipes/src/workflow/childRecipeFactory.ts:RUN_ID_SHORT_LEN).
   * The component fetches that child's CRD directly so the displayed status,
   * step output, and artifacts always belong to the requested run, not the
   * latest one. Omit to show whatever the parent recipe's `/status` endpoint
   * resolves to (server-side `resolveLatestRun` returns the most recent
   * child).
   */
  runId?: string
}

export type GrantsReadonlyPanelProps = {
  namespace: string
  recipeName: string
  editable?: boolean
  activeSection?: AccessContractKey
}

export type WorkflowExecution = {
  phase?: string
  attempt?: number
  startedAt?: string
  message?: string
}

export type StepStatus = {
  id: string
  phase: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  output?: string
  outputTruncated?: boolean
  outputLength?: number
  outputPreviewMaxChars?: number
  error?: string
  modelUsed?: string
  startedAt?: string
  completedAt?: string
}

export type WorkloadStatus = { id: string; ready: boolean; replicas?: number }

export type FailureAnalysis = {
  type: 'infra' | 'config' | 'timeout' | 'dependency' | 'auth' | 'validation' | 'unknown'
  title: string
  suggestion: string
  debugHint?: string
}
