import { useEffect, useRef } from 'react'

interface UseHostPrewarmControllerParams {
  agentNames: readonly string[]
  isAuthenticated: boolean
}

function normalizeAgentRefs(agentNames: readonly string[]): string[] {
  const refs = new Set<string>()
  for (const agentName of agentNames) {
    const ref = String(agentName || '').trim()
    if (ref) refs.add(ref)
  }
  return [...refs]
}

/**
 * Fire-and-forget pre-warm of the authenticated user's accessible agent hosts.
 *
 * Stateless hosts suspend to replicas=0 after idling and a cold wake takes
 * ~19s, so firing the wake as soon as the login-scoped access catalog is known
 * means pods are usually Ready before the user opens a specific chat. The
 * renderer does not know which hosts are stateless, so it asks the server for
 * every accessible agent and treats 409 `not-stateless` as the normal always-on
 * case. Any failure is already warn-logged by the main process — nothing here
 * may block or break view rendering.
 *
 * ANTI-FLAPPING INVARIANT — authenticated catalog only. The host status stream
 * drops and reconnects every ~300s (RPC token TTL → rpc-proxy closes with
 * `auth-expired` → the main process reconnects), and the renderer can force a
 * re-subscribe via `hostStatusReconnectNonce`. None of those paths change the
 * access catalog. Wiring prewarm to the stream lifecycle instead would
 * resurrect suspended hosts every ~5 minutes forever. Do NOT add
 * stream-derived values (reconnect nonces, stream errors, runtime status) to
 * the dependency list.
 */
export function useHostPrewarmController({
  agentNames,
  isAuthenticated,
}: UseHostPrewarmControllerParams) {
  const attemptedHostRefs = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!isAuthenticated) {
      attemptedHostRefs.current.clear()
      return
    }

    const hostRefs = normalizeAgentRefs(agentNames)
    if (!hostRefs.length) return

    for (const hostRef of hostRefs) {
      if (attemptedHostRefs.current.has(hostRef)) continue
      attemptedHostRefs.current.add(hostRef)

      window.clerum.rpc
        .prewarmHost(hostRef, hostRefs)
        .then(result => {
          if (result?.status === 'not-stateless') {
            console.debug(`[Prewarm] host=${hostRef} is always-on (not-stateless); nothing to wake`)
          }
        })
        .catch(error => {
          // Fire-and-forget: the main process already warn-logs the failure
          // with detail. The view must render regardless of the outcome.
          console.debug(`[Prewarm] request did not complete host=${hostRef}:`, error)
        })
    }
  }, [agentNames, isAuthenticated])
}
