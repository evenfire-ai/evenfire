/**
 * Maps Secret names → set of recipe names that reference them via
 * `spec.workloads[].envSecret.name`. Used by the Secret watcher to fan
 * out reconcile events when a referenced Secret's key-set changes.
 *
 * In-memory only. Rebuilt on WRC cold start by listing all recipes
 * before the Secret watcher subscribes.
 */
export class SecretReverseIndex {
  private readonly secretToRecipes = new Map<string, Set<string>>()
  private readonly recipeToSecrets = new Map<string, Set<string>>()

  /**
   * Replace the recipe's referenced-Secret set. Removes the recipe from
   * any Secret entries it no longer references; adds it to the new ones.
   */
  set(recipeName: string, secretNames: Iterable<string>): void {
    const next = new Set(secretNames)
    const prev = this.recipeToSecrets.get(recipeName) ?? new Set<string>()

    for (const secret of prev) {
      if (!next.has(secret)) this.removeRecipeFromSecret(secret, recipeName)
    }
    for (const secret of next) {
      if (!prev.has(secret)) this.addRecipeToSecret(secret, recipeName)
    }

    if (next.size === 0) {
      this.recipeToSecrets.delete(recipeName)
    } else {
      this.recipeToSecrets.set(recipeName, next)
    }
  }

  /** Forget the recipe entirely (e.g. recipe deleted). */
  delete(recipeName: string): void {
    const prev = this.recipeToSecrets.get(recipeName)
    if (!prev) return
    for (const secret of prev) {
      this.removeRecipeFromSecret(secret, recipeName)
    }
    this.recipeToSecrets.delete(recipeName)
  }

  /** Recipes that reference the given Secret. Returns an empty array if none. */
  recipesFor(secretName: string): string[] {
    const set = this.secretToRecipes.get(secretName)
    return set ? Array.from(set) : []
  }

  /** Test helper: number of distinct Secrets currently indexed. */
  secretCount(): number {
    return this.secretToRecipes.size
  }

  private addRecipeToSecret(secret: string, recipe: string): void {
    let bucket = this.secretToRecipes.get(secret)
    if (!bucket) {
      bucket = new Set<string>()
      this.secretToRecipes.set(secret, bucket)
    }
    bucket.add(recipe)
  }

  private removeRecipeFromSecret(secret: string, recipe: string): void {
    const bucket = this.secretToRecipes.get(secret)
    if (!bucket) return
    bucket.delete(recipe)
    if (bucket.size === 0) this.secretToRecipes.delete(secret)
  }
}
