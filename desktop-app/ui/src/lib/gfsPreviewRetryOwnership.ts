/** Retire retry work only when its final workspace/plugin preview owner closes. */
export function retireClosedGfsPreviewOwners(
  previousOwners: Set<string>,
  currentOwners: ReadonlySet<string>,
  retryTimers: Map<string, number>,
  retryAttempts: Map<string, number>,
  refreshGenerations: Map<string, number>,
  clearTimeoutFn: (timer: number) => void
): void {
  for (const gfsUri of previousOwners) {
    if (currentOwners.has(gfsUri)) continue
    const timer = retryTimers.get(gfsUri)
    if (timer !== undefined) clearTimeoutFn(timer)
    retryTimers.delete(gfsUri)
    retryAttempts.delete(gfsUri)
    refreshGenerations.set(gfsUri, (refreshGenerations.get(gfsUri) ?? 0) + 1)
  }

  previousOwners.clear()
  for (const gfsUri of currentOwners) previousOwners.add(gfsUri)
}
