import type { ModelGrantReference, ModelHostReference, ModelRecipeReference } from '@lib/api'

export type ModelReferencesProps = {
  hostsAffected: ModelHostReference[]
  grantsAffected: ModelGrantReference[]
  /** WorkflowRecipes naming the model; only the attention feed carries them. */
  recipesAffected?: ModelRecipeReference[]
}
