import { useEffect, useState } from 'react'

/**
 * Whether a local Evenfire is answering on this machine (spec §5.6).
 *
 * One bounded probe per mount. The main process takes no URL — it only ever
 * checks the built-in Localhost option — so the renderer cannot use this to
 * reach an arbitrary host. A failed or slow probe resolves to `false`, which
 * every caller renders as "show nothing": a machine with no local cluster
 * never sees a Localhost affordance advertising a server that isn't there.
 *
 * Optional-chained throughout because tests and stale dev preloads can leave
 * `window.clerum` partially defined, and a missing bridge must degrade to
 * "not reachable" rather than throwing during render.
 */
export function useLocalhostReachable(): boolean {
  const [reachable, setReachable] = useState(false)

  useEffect(() => {
    let cancelled = false
    const probe = window.clerum?.auth?.probeLocalhostReachable
    if (typeof probe !== 'function') return

    probe()
      .then(result => {
        if (!cancelled) setReachable(Boolean(result))
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  return reachable
}
