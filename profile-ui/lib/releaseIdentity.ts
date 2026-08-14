'use client'

import { getDesktopRelease } from './api'

export type ReleaseIdentity = {
  releaseId: string
  // The commit the serving external-rest-api image was built from. Empty when
  // the image predates the build stamp or nothing stamped it. Between releases
  // this is the only part of the identity that moves: releaseId is frozen at
  // the last cut.
  buildRevision: string
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
  if (!releaseId) return null

  const rawRevision = (payload as { buildRevision?: unknown }).buildRevision
  const buildRevision = typeof rawRevision === 'string' ? rawRevision.trim() : ''
  return { releaseId, buildRevision }
}

// The release names the lineage; the build names what is actually running.
// Between releases only the build moves, which is why the two are shown
// together here rather than the release alone.
export function formatReleaseTitle(
  releaseId: string | null,
  buildRevision = ''
): string | undefined {
  if (!releaseId) return undefined
  const release = `${RELEASE_PREFIX} ${releaseId}`
  return buildRevision ? `${release} (build ${buildRevision})` : release
}

// Release only, deliberately: the settings header is read by users, for whom the
// build revision is noise. The sidebar brand title carries the build for support.
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
