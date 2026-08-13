'use client'

import { getDesktopRelease } from './api'

export type ReleaseIdentity = {
  releaseId: string
}

export type ReleaseIdentityFetcher = () => Promise<unknown>

// The running external-rest-api image bakes its release identity in, so the
// value cannot change while the tab is open. One resolved read is cached for
// the page session and shared by the always-mounted sidebar and the settings
// page. A failed read is deliberately NOT cached: the label is decoration, and
// pinning it to "unavailable" until the next full page load would be the wrong
// trade for one transient error.
let cachedIdentity: ReleaseIdentity | null = null
let inFlight: Promise<ReleaseIdentity | null> | null = null

export function normalizeReleaseIdentity(payload: unknown): ReleaseIdentity | null {
  if (!payload || typeof payload !== 'object') return null
  const releaseId = String((payload as { releaseId?: unknown }).releaseId ?? '').trim()
  return releaseId ? { releaseId } : null
}

export function formatReleaseLabel(releaseId: string | null, loading = false): string {
  if (releaseId) return `Release ${releaseId}`
  return loading ? 'Release ...' : 'Release unavailable'
}

export function readCachedReleaseIdentity(): ReleaseIdentity | null {
  return cachedIdentity
}

export function resetReleaseIdentityCache(): void {
  cachedIdentity = null
  inFlight = null
}

export async function loadReleaseIdentity(
  fetcher: ReleaseIdentityFetcher = getDesktopRelease
): Promise<ReleaseIdentity | null> {
  if (cachedIdentity) return cachedIdentity
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const identity = normalizeReleaseIdentity(await fetcher())
      if (identity) cachedIdentity = identity
      return identity
    } catch {
      // Never surfaced to the page and never allowed to drive navigation: the
      // settings page's own getMe() call is what detects a dead session.
      return null
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}
