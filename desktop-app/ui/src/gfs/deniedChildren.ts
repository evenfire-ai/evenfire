import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { parseHttpStatus } from '@lib/gfsGrantErrors'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

/** Drop previously authorized child metadata only after an authoritative denial. */
export function purgeDeniedGfsChildren(
  queryClient: QueryClient,
  queryKey: QueryKey,
  error: unknown
): boolean {
  if (!isGfsChildrenDenied(error)) return false

  // A failed TanStack refetch retains its last successful data by design. For
  // a definitive denial, replace only cached child rows; later invalidation can
  // still refetch the same key if access is granted again.
  queryClient.setQueryData<unknown>(queryKey, current => {
    if (!current || typeof current !== 'object' || !('pages' in current)) return current
    const pages = (current as { pages?: unknown }).pages
    if (!Array.isArray(pages)) return current
    return {
      ...current,
      pages: pages.map(page =>
        page && typeof page === 'object' && 'items' in page && Array.isArray(page.items)
          ? { ...page, items: [], nextCursor: null }
          : page
      ),
    }
  })
  return true
}

export function isGfsChildrenDenied(error: unknown): boolean {
  const status = parseHttpStatus(errorMessage(error))
  return status === 403 || status === 404
}
