import { useCallback, useEffect, useRef, useState } from 'react'
import type { InPlaceObjectUrl } from './useInPlaceObjectUrl.types'

type Loaded = { source: string; url: string; blob: Blob }

/**
 * Owns the object URL of a preview that reloads in place: the previous URL stays
 * valid until its replacement is on screen, and every URL created is revoked
 * exactly once (on replacement, discard, or unmount).
 *
 * Content is only exposed for the source it was loaded from, so a caller that
 * swaps the source without remounting never shows another file's bytes.
 */
export function useInPlaceObjectUrl(source: string | null): InPlaceObjectUrl {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const loadedSourceRef = useRef<string | null>(null)
  const latestUrlRef = useRef<string | null>(null)

  const publish = useCallback((from: string, blob: Blob) => {
    const url = URL.createObjectURL(blob)
    latestUrlRef.current = url
    loadedSourceRef.current = from
    setLoaded({ source: from, url, blob })
  }, [])

  const discard = useCallback(() => {
    latestUrlRef.current = null
    loadedSourceRef.current = null
    setLoaded(null)
  }, [])

  const hasContentFor = useCallback(
    (from: string | null) => from !== null && loadedSourceRef.current === from,
    []
  )

  // Revoking from the download effect's cleanup would kill the URL on screen as
  // soon as a reload starts; instead a URL is revoked only after the commit that
  // replaced it. The latest URL is left to the unmount effect below so it is
  // never revoked twice.
  const loadedUrl = loaded?.url ?? null
  useEffect(() => {
    if (!loadedUrl) return
    return () => {
      if (loadedUrl !== latestUrlRef.current) URL.revokeObjectURL(loadedUrl)
    }
  }, [loadedUrl])

  useEffect(
    () => () => {
      const latest = latestUrlRef.current
      if (!latest) return
      latestUrlRef.current = null
      URL.revokeObjectURL(latest)
    },
    []
  )

  const current = loaded !== null && loaded.source === source ? loaded : null
  return { url: current?.url ?? null, blob: current?.blob ?? null, publish, discard, hasContentFor }
}
