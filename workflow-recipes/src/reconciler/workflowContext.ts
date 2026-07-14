import { createHash } from 'node:crypto'
import type { WorkflowRecipeCRD, WorkflowRecipeSpec } from '../types'

const CONTEXT_NAME_MAX_LENGTH = 63
const CONTEXT_NAME_HASH_LENGTH = 8

export function privateWorkflowContextName(recipeName: string): string {
  const base = `wf-${recipeName}`
  if (base.length <= CONTEXT_NAME_MAX_LENGTH) {
    return base
  }

  const hash = createHash('sha256').update(base).digest('hex').slice(0, CONTEXT_NAME_HASH_LENGTH)
  const maxStemLength = CONTEXT_NAME_MAX_LENGTH - hash.length - 1
  const stem = base.slice(0, maxStemLength).replace(/-+$/g, '') || 'wf'

  return `${stem}-${hash}`
}

export function effectiveWorkflowContextRef(recipe: WorkflowRecipeCRD): string {
  return effectiveWorkflowContextRefForSpec(recipe.metadata.name, recipe.spec)
}

export function effectiveWorkflowContextRefForSpec(
  recipeName: string,
  spec: Pick<WorkflowRecipeSpec, 'contextRef'>
): string {
  const explicit = spec.contextRef?.trim()
  return explicit || privateWorkflowContextName(recipeName)
}

export function workloadEffectiveContextRef(
  recipe: WorkflowRecipeCRD,
  hasTransport?: boolean
): string | undefined {
  return hasTransport ? effectiveWorkflowContextRef(recipe) : recipe.spec.contextRef
}
