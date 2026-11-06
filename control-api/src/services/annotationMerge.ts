/** Annotation keys under this prefix are platform-owned write-only projections. */
export const PLATFORM_ANNOTATION_PREFIX = 'clerum.io/'

/**
 * Merge annotations for a full-replace write (updateResource/mutateResource).
 *
 * - `incoming === undefined` — the caller did not touch annotations: the
 *   server's current map survives verbatim (legacy behavior).
 * - `incoming` provided — caller-owned keys keep replace semantics (the
 *   incoming map wins per key, omission clears), but platform-owned
 *   `clerum.io/*` keys present on the server are re-added unless the caller
 *   EXPLICITLY sets that exact key. Platform annotations are write-only
 *   projections owned by control-api/HCC (e.g. `clerum.io/wake-requested`,
 *   see hostWakeService.ts) — an admin PUT that happens to carry an
 *   annotations map must never erase them (AP-6 companion fix).
 */
export function mergeAnnotationsForReplace(
  current: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (incoming === undefined) return current
  const merged: Record<string, string> = { ...incoming }
  for (const [key, value] of Object.entries(current ?? {})) {
    if (key.startsWith(PLATFORM_ANNOTATION_PREFIX) && !(key in incoming)) {
      merged[key] = value
    }
  }
  return merged
}
