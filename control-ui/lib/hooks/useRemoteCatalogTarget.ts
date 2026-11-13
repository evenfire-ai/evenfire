'use client'

import { useEffect, useState } from 'react'
import { getRegistryEntryVersion, isSilentApiError } from '../api'
import { resolveRemoteCatalogTarget } from '../remoteMcp'
import type {
  RemoteCatalogEntryRef,
  RemoteCatalogTargetState,
  RemoteGrantScope,
} from '../remoteMcp.types'

/**
 * Load the catalog entry a Marketplace link names and resolve it for one slot. The URL
 * the wizard shows comes from this read, never from the link itself.
 */
export function useRemoteCatalogTarget(
  entry: RemoteCatalogEntryRef,
  grantScope: RemoteGrantScope
): RemoteCatalogTargetState {
  const [state, setState] = useState<RemoteCatalogTargetState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    getRegistryEntryVersion(entry.name, entry.version)
      .then(loaded => {
        if (cancelled) return
        const resolved = resolveRemoteCatalogTarget(loaded, grantScope)
        setState(
          'target' in resolved
            ? { status: 'ready', target: resolved.target }
            : { status: 'error', message: resolved.message }
        )
      })
      .catch((error: unknown) => {
        if (cancelled || isSilentApiError(error)) return
        setState({
          status: 'error',
          message:
            error instanceof Error && error.message
              ? `Could not load the Marketplace entry: ${error.message}`
              : 'Could not load the Marketplace entry.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [entry.name, entry.version, grantScope])

  return state
}
