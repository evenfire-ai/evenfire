import type { OperatorDefaults } from '@/lib/recipeTypes'

export type RecipeDefaultsPanelProps = {
  defaults: OperatorDefaults
  onChange: (defaults: OperatorDefaults) => void
}
