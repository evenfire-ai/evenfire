/**
 * Tiny in-memory cache that lets the row thumbnail and the preview
 * modal share a single object URL for the same image bytes. Without
 * this the preview modal would re-fetch the same image every time it
 * opens, which dominates the "preview feels slow" complaint.
 *
 * The cache is module-scoped and survives navigation between folders.
 * Entries stay valid for the lifetime of the renderer; when the
 * window unloads the underlying blob URLs are released by the browser.
 */
export type CachedGfsBlob = {
  blobUrl: string
  mimeType: string
}

const blobUrlCache = new Map<string, CachedGfsBlob>()

export function getCachedGfsBlob(rid: string): CachedGfsBlob | null {
  return blobUrlCache.get(rid) ?? null
}

export function setCachedGfsBlob(rid: string, entry: CachedGfsBlob): void {
  blobUrlCache.set(rid, entry)
}

export function clearCachedGfsBlob(rid: string): void {
  blobUrlCache.delete(rid)
}
