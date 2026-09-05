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

// One resolved read is cached for the page session and shared by the
// always-mounted sidebar and the settings page. A failed first read is not
// cached, so the next mount retries. Refresh drops any in-flight read and
// re-asks; a failed re-read keeps the last good value rather than publishing
// "unavailable" over a label that was already correct. loadGeneration lets an
// abandoned in-flight promise finish without clobbering a newer read.
let cachedIdentity: ReleaseIdentity | null = null
let inFlight: Promise<ReleaseIdentity | null> | null = null
let loadGeneration = 0

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
  // Isolate each subscriber so a throw cannot rewind the cache or reject the read.
  for (const listener of [...listeners]) {
    try {
      listener(identity)
    } catch {
      // The label is decoration; a broken subscriber is not a failed read.
    }
  }
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
  loadGeneration += 1
}

export async function loadReleaseIdentity(
  fetcher: ReleaseIdentityFetcher = getDesktopRelease
): Promise<ReleaseIdentity | null> {
  return readReleaseIdentity(fetcher, false)
}

// Drops any in-flight read so the next load re-asks. The settings Refresh
// button routes through here, which is what lets a label that caught a
// transient failure heal in place rather than waiting to be remounted. A
// failed re-read keeps the last good value; clearing the cache first would
// publish "unavailable" onto every mounted label for one 502.
export async function refreshReleaseIdentity(
  fetcher: ReleaseIdentityFetcher = getDesktopRelease
): Promise<ReleaseIdentity | null> {
  loadGeneration += 1
  inFlight = null
  return readReleaseIdentity(fetcher, true)
}

async function readReleaseIdentity(
  fetcher: ReleaseIdentityFetcher,
  force: boolean
): Promise<ReleaseIdentity | null> {
  if (!force && cachedIdentity) return cachedIdentity
  if (inFlight) return inFlight

  const generation = loadGeneration
  const request = (async (): Promise<ReleaseIdentity | null> => {
    let identity: ReleaseIdentity | null = null
    try {
      identity = normalizeReleaseIdentity(await fetcher())
    } catch {
      // Never surfaced to the page and never allowed to drive navigation: the
      // settings page's own getMe() call is what detects a dead session.
      identity = null
    } finally {
      if (generation === loadGeneration) inFlight = null
    }

    if (generation !== loadGeneration) return cachedIdentity
    if (identity) {
      cachedIdentity = identity
      publishReleaseIdentity(identity)
      return identity
    }
    if (cachedIdentity) return cachedIdentity
    publishReleaseIdentity(null)
    return null
  })()

  inFlight = request
  return request
}
