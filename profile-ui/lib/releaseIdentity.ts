'use client'

import { getDesktopRelease } from './api'

export type ReleaseIdentity = {
  releaseId: string
}

export type ReleaseIdentityFetcher = () => Promise<unknown>

export type ReleaseIdentityListener = (identity: ReleaseIdentity | null) => void

// One prefix, one place. Both call sites render it: the settings line through
// formatReleaseLabel, the sidebar brand through formatReleaseTitle.
const RELEASE_PREFIX = 'Release'

// The running external-rest-api image bakes its release identity in, so the
// value cannot change while the tab is open. One resolved read is cached for
// the page session and shared by the always-mounted sidebar and the settings
// page. A failed read is deliberately NOT cached: the label is decoration, and
// pinning it to "unavailable" until the next full page load would be the wrong
// trade for one transient error.
let cachedIdentity: ReleaseIdentity | null = null
let inFlight: Promise<ReleaseIdentity | null> | null = null

// Every mounted label subscribes, so a read resolved by one of them lands on
// all of them. Without this, an instance that caught a transient failure would
// keep showing "unavailable" until it happened to remount, even after a later
// read succeeded.
const listeners = new Set<ReleaseIdentityListener>()

export function subscribeReleaseIdentity(listener: ReleaseIdentityListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publishReleaseIdentity(identity: ReleaseIdentity | null): void {
  // Iterate a copy: a listener may unsubscribe (unmount) while being notified.
  for (const listener of [...listeners]) listener(identity)
}

export function normalizeReleaseIdentity(payload: unknown): ReleaseIdentity | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = (payload as { releaseId?: unknown }).releaseId
  // typeof rather than String(): coercion would turn an object into the truthy
  // "[object Object]" and accept it as a release name.
  if (typeof raw !== 'string') return null
  const releaseId = raw.trim()
  return releaseId ? { releaseId } : null
}

export function formatReleaseTitle(releaseId: string | null): string | undefined {
  return releaseId ? `${RELEASE_PREFIX} ${releaseId}` : undefined
}

export function formatReleaseLabel(releaseId: string | null, loading = false): string {
  const title = formatReleaseTitle(releaseId)
  if (title) return title
  return loading ? `${RELEASE_PREFIX} ...` : `${RELEASE_PREFIX} unavailable`
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
      publishReleaseIdentity(identity)
      return identity
    } catch {
      // Never surfaced to the page and never allowed to drive navigation: the
      // settings page's own getMe() call is what detects a dead session.
      publishReleaseIdentity(null)
      return null
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

// Drops a resolved read so the next load re-asks. The settings Refresh button
// routes through here, which is what lets a label that caught a transient
// failure heal in place rather than waiting to be remounted.
export async function refreshReleaseIdentity(
  fetcher: ReleaseIdentityFetcher = getDesktopRelease
): Promise<ReleaseIdentity | null> {
  cachedIdentity = null
  return loadReleaseIdentity(fetcher)
}
