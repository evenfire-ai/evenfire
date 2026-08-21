/**
 * Tiny in-memory cache that lets the row thumbnail and the preview
 * modal share a single object URL for the same image bytes. Without
 * this the preview modal would re-fetch the same image every time it
 * opens, which dominates the "preview feels slow" complaint.
 *
 * The cache is module-scoped and survives navigation between folders while
 * a thumbnail or preview still references an entry. The last consumer
 * releases the object URL; window unload also releases any remaining URLs.
 */
export type CachedGfsBlob = {
  blobUrl: string
  mimeType: string
}

type CacheEntry = CachedGfsBlob & {
  references: number
}

const blobUrlCache = new Map<string, CacheEntry>()

export function getCachedGfsBlob(rid: string): CachedGfsBlob | null {
  return blobUrlCache.get(rid) ?? null
}

/**
 * Store a URL and claim its first owner. If another loader won the race for
 * this resource, retain that URL and release the newly-created one instead.
 */
export function setCachedGfsBlob(rid: string, entry: CachedGfsBlob): CachedGfsBlob {
  const existing = blobUrlCache.get(rid)
  if (existing) {
    if (existing.blobUrl !== entry.blobUrl) URL.revokeObjectURL(entry.blobUrl)
    existing.references += 1
    return existing
  }
  const cacheEntry = { ...entry, references: 1 }
  blobUrlCache.set(rid, cacheEntry)
  return cacheEntry
}

export function retainCachedGfsBlob(rid: string, blobUrl: string): boolean {
  const entry = blobUrlCache.get(rid)
  if (!entry || entry.blobUrl !== blobUrl) return false
  entry.references += 1
  return true
}

export function releaseCachedGfsBlob(rid: string, blobUrl: string): void {
  const entry = blobUrlCache.get(rid)
  if (!entry || entry.blobUrl !== blobUrl) return
  entry.references -= 1
  if (entry.references > 0) return
  blobUrlCache.delete(rid)
  URL.revokeObjectURL(blobUrl)
}

export function clearCachedGfsBlob(rid: string, blobUrl?: string): void {
  const entry = blobUrlCache.get(rid)
  if (!entry || (blobUrl !== undefined && entry.blobUrl !== blobUrl)) return
  blobUrlCache.delete(rid)
}
