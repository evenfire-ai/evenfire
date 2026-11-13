import type { PermissionErrorItem } from './PermissionErrorDialog/types'

const acknowledged = new WeakMap<object, Set<number>>()

export function isPermissionErrorAcknowledged(error: PermissionErrorItem): boolean {
  if (!error.queryIdentity || error.errorUpdateCount === undefined) return false
  return acknowledged.get(error.queryIdentity)?.has(error.errorUpdateCount) ?? false
}

export function acknowledgePermissionErrors(errors: PermissionErrorItem[]): void {
  for (const error of errors) {
    if (!error.queryIdentity || error.errorUpdateCount === undefined) continue
    let generations = acknowledged.get(error.queryIdentity)
    if (!generations) {
      generations = new Set<number>()
      acknowledged.set(error.queryIdentity, generations)
    }
    generations.add(error.errorUpdateCount)
  }
}
