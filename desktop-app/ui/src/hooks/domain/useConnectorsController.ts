import { useCallback, useEffect, useMemo, useState } from 'react'
import { focusManager, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RpcAgentConnectors, RpcConnector } from '../../../../src/types'
import { connectorRowKey, isActionableConnector, isSharedConnector } from '../../lib/connectorRows'
import { formatMcpServerDisplayName } from '../../lib/format'
import { desktopQueryKeys } from './queryKeys'

// Re-exported from their new home in `lib/` so existing importers (the pages)
// keep their `from '.../useConnectorsController'` path. The layering rule is that
// `lib/` never imports from `hooks/` — these pure predicates belong in `lib/`.
export { isActionableConnector, isSharedConnector }

const EMPTY_AGENTS: RpcAgentConnectors[] = []

/**
 * Bounded staleness for a surface that shows the catalog (#991). Opening it, or
 * regaining window focus, refetches once the cache is older than
 * `CONNECTORS_STALE_AFTER_MS`; while it stays open it re-checks every
 * `CONNECTORS_POLL_INTERVAL_MS`. A connector an admin adds or removes therefore
 * reaches the user within a minute instead of at the next sign-in.
 */
export const CONNECTORS_STALE_AFTER_MS = 15_000
export const CONNECTORS_POLL_INTERVAL_MS = 60_000

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * User-facing copy for a connect/disconnect WRITE failure. The action call
 * sites used to swallow the rejection (`.catch(() => undefined)`), so a 403 /
 * 502 / network drop looked identical to a cancelled dialog: the grant stayed
 * live and the user believed they had changed it. The hook now records the
 * outcome and both pages render it in the error banner they already mount.
 */
function toActionErrorMessage(
  verb: 'connect' | 'disconnect',
  connector: Pick<RpcConnector, 'name'>,
  error: unknown
): string {
  const name = formatMcpServerDisplayName(connector.name)
  return `Couldn't ${verb} "${name}". ${toErrorMessage(error)}`
}

export type ConnectorActionInput = {
  agentName: string
  contextRef: string | null
  connector: RpcConnector
}

export type ConnectorsControllerOptions = {
  /** Keep the catalog fresh while the calling surface is visible (#991). */
  autoRefresh?: boolean
}

export function useConnectorsController({ autoRefresh = false }: ConnectorsControllerOptions = {}) {
  const queryClient = useQueryClient()
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  // The OUTCOME of the last write (connect/disconnect). The hook owns the action
  // lifecycle (`pendingKey` start / `finally` end); it must also own the error,
  // because neither page imports `pushToast` and the query `error` below only
  // ever reflects the READ (`listConnectors`), never a write.
  const [actionError, setActionError] = useState<string | null>(null)

  // Mirrors the sibling data-controllers (useMcpServersDataController /
  // useContextsDataController): the query is app-coordinated, never
  // self-enabling. `useAppController` owns the initial load (post-auth
  // bootstrap) and the identity teardown (`reset` on logout / team-switch), so
  // a team-switch cannot leak the previous identity's OAuth authorization state
  // (the key is identity-unscoped). A surface that shows the catalog may opt
  // into bounded refetches with `autoRefresh` (#991); they go through the same
  // imperative `refresh`, never through the query enabling itself.
  const query = useQuery({
    queryKey: desktopQueryKeys.connectors,
    queryFn: () => window.clerum.rpc.listConnectors(),
    enabled: false,
  })

  // Imperative refetch (fetchQuery), not refetchQueries/invalidateQueries: an
  // `enabled:false` observer is NOT refetched by those in react-query v5, so the
  // U3/U4 reactivity (disconnect / OAuth deep-link return) has to drive the fetch
  // explicitly — exactly how the sibling controllers' `refresh` works.
  const refresh = useCallback(async () => {
    try {
      await queryClient.fetchQuery({
        queryKey: desktopQueryKeys.connectors,
        queryFn: () => window.clerum.rpc.listConnectors(),
        staleTime: 0,
      })
    } catch {
      // Query state already records the error for consumers.
    }
  }, [queryClient])

  // Reads the cache state at call time (not a render snapshot) so the poll and
  // focus listeners never act on a stale closure. A fetch already in flight —
  // e.g. the post-auth bootstrap — is not duplicated. After `reset` the query is
  // gone (`dataUpdatedAt` 0), so the next call fetches the new identity.
  const refreshIfStale = useCallback(
    async (maxAgeMs: number = CONNECTORS_STALE_AFTER_MS) => {
      const state = queryClient.getQueryState(desktopQueryKeys.connectors)
      if (state?.fetchStatus === 'fetching') return
      if (state && state.dataUpdatedAt > 0 && Date.now() - state.dataUpdatedAt < maxAgeMs) return
      await refresh()
    },
    [queryClient, refresh]
  )

  // Opt-in, so the query stays app-coordinated: only a visible surface drives
  // these refetches, and each goes through `refresh` (identity teardown intact).
  useEffect(() => {
    if (!autoRefresh) return undefined
    void refreshIfStale()
    const interval = window.setInterval(() => {
      void refreshIfStale(CONNECTORS_POLL_INTERVAL_MS)
    }, CONNECTORS_POLL_INTERVAL_MS)
    // `useWindowFocusBridge` forwards Electron window focus into focusManager.
    const unsubscribeFocus = focusManager.subscribe(isFocused => {
      if (isFocused) void refreshIfStale()
    })
    return () => {
      window.clearInterval(interval)
      unsubscribeFocus()
    }
  }, [autoRefresh, refreshIfStale])

  const reset = useCallback(() => {
    queryClient.removeQueries({ queryKey: desktopQueryKeys.connectors })
  }, [queryClient])

  const authorize = useCallback(
    async ({ agentName, contextRef, connector }: ConnectorActionInput) => {
      const shared = isSharedConnector(connector)
      // For `oauth-context`, control-api resolves the authoritative Context from
      // the server CR; passing the agent's contextRef only helps main pick the
      // right host binding / confirm copy. `oauth-user` grants carry no Context.
      const contextId = shared ? (contextRef ?? undefined) : undefined
      // Anchor the busy state to the VISIBLE (context, server) row, not to the
      // representative agent, so the spinner tracks the row the user clicked.
      const key = connectorRowKey(contextRef, connector.name)
      setActionError(null)
      setPendingKey(key)
      try {
        // The grant becomes present only after the OAuth deep-link returns; U3's
        // completion handler refreshes the panel then. Nothing to refresh here
        // (an unconfirmed shared dialog is a no-op main-side).
        await window.clerum.rpc.connectMcpServer(connector.name, agentName, contextId, {
          confirmShared: shared,
        })
      } catch (error) {
        setActionError(toActionErrorMessage('connect', connector, error))
      } finally {
        setPendingKey(current => (current === key ? null : current))
      }
    },
    []
  )

  const disconnect = useCallback(
    async ({ agentName, contextRef, connector }: ConnectorActionInput) => {
      const shared = isSharedConnector(connector)
      const contextId = shared ? (contextRef ?? undefined) : undefined
      // Anchor the busy state to the VISIBLE (context, server) row, not to the
      // representative agent, so the spinner tracks the row the user clicked.
      const key = connectorRowKey(contextRef, connector.name)
      setActionError(null)
      setPendingKey(key)
      try {
        const result = await window.clerum.rpc.disconnectMcpServer(
          connector.name,
          agentName,
          contextId,
          { shared }
        )
        // Only a CONFIRMED revoke changes the grant store; a cancelled dialog
        // (`confirmed:false`) is a main-side no-op, so it must not refetch (U4).
        if (result?.confirmed) {
          await refresh()
        }
        return result
      } catch (error) {
        // A rejected DELETE (403 context_membership_denied, 502, network) leaves
        // the grant LIVE; surface it so the final screen is not identical to a
        // cancelled dialog. Returns undefined (no confirmed revoke) after that.
        setActionError(toActionErrorMessage('disconnect', connector, error))
        return undefined
      } finally {
        setPendingKey(current => (current === key ? null : current))
      }
    },
    [refresh]
  )

  const agents = query.data?.agents ?? EMPTY_AGENTS

  return useMemo(
    () => ({
      loading: query.status === 'pending' || query.fetchStatus === 'fetching',
      error: query.error ? toErrorMessage(query.error) : null,
      actionError,
      agents,
      pendingKey,
      refresh,
      refreshIfStale,
      reset,
      authorize,
      disconnect,
    }),
    [
      actionError,
      agents,
      authorize,
      disconnect,
      pendingKey,
      query.error,
      query.fetchStatus,
      query.status,
      refresh,
      refreshIfStale,
      reset,
    ]
  )
}
