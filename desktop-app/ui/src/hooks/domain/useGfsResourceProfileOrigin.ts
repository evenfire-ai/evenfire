import { useContext, useEffect, useRef, useState } from 'react'
import { AuthContext } from '@contexts/AuthContext'
import { normalizeProfileOrigin } from '../../lib/gfsResourceLinks'

type ProfileOriginState = { identity: string; origin: string }

/** Resolve Profile link trust from the authenticated main-process configuration. */
export function useGfsResourceProfileOrigin(): string | null {
  const auth = useContext(AuthContext)
  const envKey = auth?.runtimeConfigState?.envKey ?? ''
  const sourceIdentity =
    auth?.isAuthenticated && auth.me && !auth.authTransitioning
      ? [
          envKey,
          auth.me.id,
          auth.me.email,
          auth.me.teamId ?? '',
          auth.runtimeConfigState?.currentConfig?.externalRestApiBaseUrl ?? '',
          auth.runtimeConfigState?.currentConfig?.rpcProxyBaseUrl ?? '',
        ].join(':')
      : null
  const lifecycleRef = useRef<{ sourceIdentity: string | null; generation: number }>({
    sourceIdentity: null,
    generation: 0,
  })
  if (lifecycleRef.current.sourceIdentity !== sourceIdentity) {
    lifecycleRef.current = {
      sourceIdentity,
      generation: lifecycleRef.current.generation + 1,
    }
  }
  const identity = sourceIdentity ? `${sourceIdentity}:${lifecycleRef.current.generation}` : null
  const [state, setState] = useState<ProfileOriginState | null>(null)
  const requestGenerationRef = useRef(0)

  useEffect(() => {
    const requestGeneration = ++requestGenerationRef.current
    if (!identity || !envKey) {
      setState(null)
      return
    }
    let cancelled = false
    setState(null)
    void (async () => {
      const getSessionGeneration = window.clerum.auth?.getSessionGeneration
      const getResourceProfileOrigin = window.clerum.gfs?.getResourceProfileOrigin
      if (!getSessionGeneration || !getResourceProfileOrigin) return
      const before = await getSessionGeneration()
      const result = await getResourceProfileOrigin()
      const after = await getSessionGeneration()
      const origin = normalizeProfileOrigin(result?.origin)
      if (
        cancelled ||
        requestGenerationRef.current !== requestGeneration ||
        before !== after ||
        result?.sessionGeneration !== after ||
        result?.envKey !== envKey ||
        !origin
      ) {
        return
      }
      setState({ identity, origin })
    })().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [envKey, identity])

  return state?.identity === identity ? state.origin : null
}
