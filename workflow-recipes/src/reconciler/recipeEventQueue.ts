export class RecipeEventQueue {
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly onError?: (key: string, error: unknown) => void) {}

  // Tasks may resolve with a value (handleRecipeEvent returns its outcome); the
  // queue only sequences them, so the value is discarded.
  enqueue(key: string, task: () => Promise<unknown>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    let next: Promise<void>

    next = previous
      .catch(() => undefined)
      .then(task)
      .then(() => undefined)
      .catch(error => {
        this.onError?.(key, error)
      })
      .finally(() => {
        if (this.chains.get(key) === next) {
          this.chains.delete(key)
        }
      })

    this.chains.set(key, next)
    return next
  }

  drain(key: string): Promise<void> {
    return this.chains.get(key) ?? Promise.resolve()
  }
}
