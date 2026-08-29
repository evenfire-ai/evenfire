import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RpcAgentConnectors, RpcConnector } from '../../../../src/types'
import { connectorRowKey, isActionableConnector, isSharedConnector } from '../../lib/connectorRows'
import { formatMcpServerDisplayName } from '../../lib/format'
import { desktopQueryKeys } from './queryKeys'

// Re-exported from their new home in `lib/` so existing importers (the pages)
// keep their `from '.../useConnectorsController'` path. The layering rule is that
// `lib/` never imports from `hooks/` — these pure predicates belong in `lib/`.
export { isActionableConnector, isSharedConnector }

const EMPTY_AGENTS: RpcAgentConnectors[] = []

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

export function useConnectorsController() {
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
  // bootstrap) and the identity teardown (`reset` on logout / team-switch),
  // so a nav to the panel only READS cache and a team-switch cannot leak the
  // previous identity's OAuth authorization state (the key is identity-unscoped).
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
      reset,
    ]
  )
}
