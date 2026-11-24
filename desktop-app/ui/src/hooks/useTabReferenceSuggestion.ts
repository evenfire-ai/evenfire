import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { TAB_REFERENCE_RETRY_DELAYS_MS } from '@constants/tabReferenceSuggestion'
import { buildComposerFileReferences } from '@lib/composerFileReferences'
import { bumpRevision, deriveTabReferenceTarget } from '@lib/tabReferenceSuggestion'
import type { TabReferenceRevision } from '@lib/tabReferenceSuggestion.types'
import type { ComposerGlobalFileReference } from '@/uiTypes'
import type {
  TabReferenceSuggestion,
  TabReferenceSuggestionInput,
} from './useTabReferenceSuggestion.types'

type NavigationResolution = Awaited<ReturnType<Window['clerum']['gfs']['resolveForNavigation']>>

type CacheEntry = {
  key: string
  gfsUri: string
  scope: string
  result: { status: 'ready'; candidate: ComposerGlobalFileReference } | { status: 'none' }
}

type Outcome =
  | { kind: 'usable'; candidate: ComposerGlobalFileReference }
  | { kind: 'unusable' }
  | { kind: 'transient' }

const MAX_ATTEMPTS = TAB_REFERENCE_RETRY_DELAYS_MS.length + 1

function classifyResolution(
  resolution: NavigationResolution,
  gfsUri: string,
  minVersion: number | undefined
): Outcome {
  if (resolution?.status !== 'resolved') return { kind: 'transient' }
  const resource = resolution.resource
  if (resource.kind !== 'file') return { kind: 'unusable' }
  if (normalizeGfsResourceUri(resource.gfsUri) !== gfsUri) return { kind: 'unusable' }
  // The host refuses the whole turn when a reference declares the wrong size,
  // so a resource without one cannot be offered.
  if (typeof resource.bytes !== 'number') return { kind: 'unusable' }
  const candidate: ComposerGlobalFileReference = {
    id: `global-file:${resource.drive}:${resource.resourceId}`,
    type: 'global_file',
    resourceId: resource.resourceId,
    drive: resource.drive,
    gfsUri: resource.gfsUri,
    label: resource.name,
    version: resource.version,
    bytes: resource.bytes,
  }
  try {
    buildComposerFileReferences([candidate])
  } catch {
    // Not a valid reference for this resource; asking again returns the same.
    return { kind: 'unusable' }
  }
  // The preview already shows a newer version: this answer lags behind and may
  // catch up, so it is retried instead of cached.
  if (minVersion !== undefined && resource.version < minVersion) return { kind: 'transient' }
  return { kind: 'usable', candidate }
}

/**
 * Whether the cached entry may be shown for the current target. Besides its own
 * key, this serves a key the target has since moved past (a later revision or
 * reload of the same file) while that key revalidates: same file, same
 * authority and, for a preview, not older than the version on screen.
 */
function displayable(
  cache: CacheEntry | null,
  gfsUri: string | null,
  scope: string,
  minVersion: number | undefined
): cache is CacheEntry & { result: { status: 'ready' } } {
  if (!cache || gfsUri === null || cache.result.status !== 'ready') return false
  if (cache.scope !== scope || cache.gfsUri !== gfsUri) return false
  return minVersion === undefined || cache.result.candidate.version >= minVersion
}

/**
 * The active tab's file as a resolved, ready-to-attach reference for the drawer
 * composer. The resolve runs before any click, so accepting the suggestion is
 * synchronous. One entry is cached and the latest request wins.
 */
export function useTabReferenceSuggestion({
  activeTab,
  navItem,
  filesResolvedLocation,
  authorityScope,
  drawerVisible,
}: TabReferenceSuggestionInput): TabReferenceSuggestion {
  const [revision, setRevision] = useState<TabReferenceRevision>(0)
  const [cache, setCache] = useState<CacheEntry | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  const target = useMemo(
    () => deriveTabReferenceTarget(activeTab, navItem, filesResolvedLocation, revision),
    [activeTab, navItem, filesResolvedLocation, revision]
  )
  const gfsUri = target?.gfsUri ?? null
  const prefetchKey = target?.prefetchKey ?? null
  const minVersion =
    target && activeTab?.kind === 'preview' ? activeTab.preview?.resourceVersion : undefined

  // Written after commit rather than during render: a render React discards
  // (StrictMode, an interrupted transition) must not become the target a watch
  // event is compared against.
  const targetUriRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    targetUriRef.current = gfsUri
  })

  // Stable on purpose: the watch handlers that call it capture it once. The
  // target is read when the event arrives, not when React runs the update.
  const invalidate = useCallback((uri: string) => {
    const targetGfsUri = targetUriRef.current
    setRevision(n => bumpRevision(n, uri, targetGfsUri))
  }, [])

  const requestRef = useRef<{ requestKey: string; seq: number } | null>(null)
  const seqCounterRef = useRef(0)
  const attemptsRef = useRef<{ requestKey: string; n: number } | null>(null)
  const retryTimerRef = useRef<{ requestKey: string; id: ReturnType<typeof setTimeout> } | null>(
    null
  )
  const mountedRef = useRef(true)

  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current.id)
    retryTimerRef.current = null
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelRetry()
    }
  }, [cancelRetry])

  useEffect(() => {
    const currentKey = gfsUri !== null ? `${authorityScope}|${prefetchKey}` : null
    if (retryTimerRef.current && retryTimerRef.current.requestKey !== currentKey) cancelRetry()
    if (gfsUri === null || prefetchKey === null || !drawerVisible) {
      requestRef.current = null
      cancelRetry()
      return
    }
    if (cache && cache.key === prefetchKey && cache.scope === authorityScope) {
      // Whatever is still in flight belongs to a target the user already left.
      requestRef.current = null
      return
    }
    const requestKey = `${authorityScope}|${prefetchKey}`
    if (requestRef.current?.requestKey === requestKey) return

    const seq = ++seqCounterRef.current
    requestRef.current = { requestKey, seq }
    const scope = authorityScope

    const settle = (outcome: Outcome) => {
      if (requestRef.current?.seq !== seq) return
      requestRef.current = null
      if (outcome.kind !== 'transient') {
        attemptsRef.current = null
        const result =
          outcome.kind === 'usable'
            ? { status: 'ready' as const, candidate: outcome.candidate }
            : { status: 'none' as const }
        setCache({ key: prefetchKey, gfsUri, scope, result })
        return
      }
      const failures = attemptsRef.current
      const n = failures?.requestKey === requestKey ? failures.n + 1 : 1
      attemptsRef.current = { requestKey, n }
      if (n >= MAX_ATTEMPTS) {
        // A candidate shown while revalidating is dropped here too: the key
        // moved, so the file may have changed (a watched change, a resync, a
        // reload or another view of it) after that candidate was resolved.
        // Without a fresh answer that cannot be ruled out, so it is not offered.
        setCache({ key: prefetchKey, gfsUri, scope, result: { status: 'none' } })
        return
      }
      if (!mountedRef.current) return
      retryTimerRef.current = {
        requestKey,
        id: setTimeout(
          () => {
            retryTimerRef.current = null
            setRetryNonce(value => value + 1)
          },
          TAB_REFERENCE_RETRY_DELAYS_MS[n - 1]
        ),
      }
    }

    window.clerum.gfs.resolveForNavigation(gfsUri).then(
      resolution => settle(classifyResolution(resolution, gfsUri, minVersion)),
      // The bridge is documented never to reject. If it does, the suggestion is
      // optional: it is retried like any transient failure, then dropped.
      () => settle({ kind: 'transient' })
    )
    // No cleanup on purpose: StrictMode's mount/cleanup/mount must neither drop
    // the request in flight nor spend an attempt; the steps above decide what is
    // stale. `minVersion` is not a dep because a preview's key already has it.
  }, [gfsUri, prefetchKey, authorityScope, drawerVisible, cache, retryNonce])

  const candidate =
    drawerVisible && displayable(cache, gfsUri, authorityScope, minVersion)
      ? cache.result.candidate
      : null

  return { candidate, invalidate }
}
