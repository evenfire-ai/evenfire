/** Collect every JSON leaf path: primitives and arrays (arrays also recurse). */
export function collectLeafPaths(value: unknown, prefix: string[] = []): string[][] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    const nested = value.flatMap((item, index) =>
      collectLeafPaths(item, [...prefix, String(index)])
    )
    return [prefix, ...nested]
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      collectLeafPaths(entry, [...prefix, key])
    )
  }
  return [prefix]
}

export function getAtPath(root: unknown, path: string[]): unknown {
  let cursor: unknown = root
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

export function setAtPath(root: unknown, path: string[], next: unknown): void {
  if (path.length === 0) return
  let cursor: Record<string, unknown> = root as Record<string, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i]] as Record<string, unknown>
  }
  cursor[path[path.length - 1]] = next
}

/** Spec §7.2(a): string +'-x', number +1, boolean flip, array drop one element. */
export function mutateLeaf(value: unknown): unknown {
  if (typeof value === 'string') return `${value}-x`
  if (typeof value === 'number') return value + 1
  if (typeof value === 'boolean') return !value
  if (Array.isArray(value)) return value.length === 0 ? ['_sweep'] : value.slice(0, -1)
  return value
}

export function cloneAndMutateLeaf(root: unknown, path: string[]): unknown {
  const clone = structuredClone(root)
  setAtPath(clone, path, mutateLeaf(getAtPath(clone, path)))
  return clone
}

export function formatLeafPath(path: string[]): string {
  return path.length === 0 ? '(root)' : path.join('.')
}
