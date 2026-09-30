export interface GfsHierarchyResource {
  resourceId: string
  rid: string
  gfsUri: string
  name: string
  kind: string
  path: string | null
  version: number
}

export type GfsHierarchyResult =
  | { kind: 'resolved'; ancestors: GfsHierarchyResource[] }
  | { kind: 'missing' }
  | { kind: 'retry' }
  | { kind: 'preserve' }

function isAuthoritativeDenial(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: unknown }).status
  return status === 403 || status === 404
}

/** Resolve a complete folder trail without publishing a partial ancestry. */
export async function resolveGfsHierarchy(input: {
  readCurrent: () => Promise<GfsHierarchyResource>
  readAncestor: (path: string) => Promise<GfsHierarchyResource>
  isTransient: (error: unknown) => boolean
}): Promise<GfsHierarchyResult> {
  let current: GfsHierarchyResource
  try {
    current = await input.readCurrent()
  } catch (error) {
    if (isAuthoritativeDenial(error)) return { kind: 'missing' }
    return { kind: input.isTransient(error) ? 'retry' : 'preserve' }
  }

  if (current.kind !== 'directory') return { kind: 'missing' }
  if (!current.path || !current.path.startsWith('/')) return { kind: 'preserve' }

  const ancestors: GfsHierarchyResource[] = []
  let path = ''
  for (const segment of current.path.split('/').filter(Boolean)) {
    path += `/${segment}`
    let ancestor: GfsHierarchyResource
    try {
      ancestor = await input.readAncestor(path)
    } catch (error) {
      // A missing ancestor does not prove the stable-id folder was revoked.
      // Keep the full last-known trail until the whole ancestry resolves.
      return { kind: input.isTransient(error) ? 'retry' : 'preserve' }
    }
    if (ancestor.kind !== 'directory') return { kind: 'preserve' }
    ancestors.push(ancestor)
  }

  if (ancestors[ancestors.length - 1]?.resourceId !== current.resourceId) {
    return { kind: 'preserve' }
  }
  return { kind: 'resolved', ancestors }
}
