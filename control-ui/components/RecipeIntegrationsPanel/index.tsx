'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  type UserGrant,
  type WorkflowRecipeResource,
  adminListUserGrants,
  adminRevokeUserGrant,
  connectRecipeOauth,
  disconnectRecipeOauth,
  getRecipeOauthStatus,
} from '../../lib/api'
import { useConfirmDialog } from '../ConfirmDialog'
import { TablePanelHeader } from '../TablePanelHeader'
import { useToast } from '../Toast'
import { IconRefresh } from '../icons'

type OAuthClient = {
  id: string
  provider: string
  scopes?: string[]
  backgroundAccess?: boolean
}

type ConnState = 'unknown' | 'connected' | 'disconnected'

type Row = {
  client: OAuthClient
  state: ConnState
}

type UserGrantsState = 'idle' | 'loading' | 'ready' | 'error'

type UserGrantsRowState = {
  loadState: UserGrantsState
  users: UserGrant[]
  expanded: boolean
  busyUserId: string | null
}

function extractBackgroundClients(recipe: WorkflowRecipeResource | null): OAuthClient[] {
  const spec = (recipe?.spec ?? {}) as Record<string, unknown>
  const clients = Array.isArray(spec.oauthClients)
    ? (spec.oauthClients as Array<Record<string, unknown>>)
    : []
  return clients
    .filter(c => c.backgroundAccess === true && typeof c.id === 'string')
    .map(c => ({
      id: String(c.id),
      provider: typeof c.provider === 'string' ? c.provider : 'unknown',
      scopes: Array.isArray(c.scopes) ? (c.scopes as string[]) : undefined,
      backgroundAccess: true,
    }))
}

/**
 * Background-OAuth ("connect for the recipe") panel — Path B, spec §8.4.
 *
 * Lists every `oauthClients[]` entry with `backgroundAccess: true` and lets an
 * admin connect a recipe-owned `service` grant, see its connected state, or
 * disconnect it. Connect opens the provider authorize URL in a new tab; the
 * operator finishes the flow there and returns to refresh status.
 *
 * Each client row also exposes a read-only "Per-user connections" subsection
 * (expanded on demand) showing which users have granted access, with a
 * force-revoke action behind a danger confirm dialog.
 */
export function RecipeIntegrationsPanel({ recipe }: { recipe: WorkflowRecipeResource | null }) {
  const clients = useMemo(() => extractBackgroundClients(recipe), [recipe])
  const recipeName = recipe?.metadata?.name ?? ''

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyClientId, setBusyClientId] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()

  // Per-client user-grants state, keyed by client.id
  const [userGrantsMap, setUserGrantsMap] = useState<Record<string, UserGrantsRowState>>({})

  const loadStatuses = useCallback(async () => {
    if (!recipeName || clients.length === 0) {
      setRows(clients.map(client => ({ client, state: 'unknown' as ConnState })))
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const results = await Promise.all(
        clients.map(async client => {
          try {
            const { connected } = await getRecipeOauthStatus(recipeName, client.id)
            return { client, state: (connected ? 'connected' : 'disconnected') as ConnState }
          } catch {
            return { client, state: 'unknown' as ConnState }
          }
        })
      )
      setRows(results)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load integration status')
    } finally {
      setLoading(false)
    }
  }, [recipeName, clients])

  useEffect(() => {
    void loadStatuses()
  }, [loadStatuses])

  async function handleConnect(client: OAuthClient) {
    setBusyClientId(client.id)
    setError('')
    try {
      const { authorizeUrl } = await connectRecipeOauth(recipeName, client.id)
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer')
      showToast(`Authorize ${client.provider} in the new tab, then click Refresh to update.`, {
        tone: 'info',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to start ${client.provider} connect`)
    } finally {
      setBusyClientId(null)
    }
  }

  async function handleDisconnect(client: OAuthClient) {
    const shouldDisconnect = await confirm({
      title: 'Disconnect Integration',
      message: `Disconnect ${client.provider} for recipe "${recipeName}"? Background workloads will lose access until it is reconnected.`,
      confirmLabel: 'Disconnect',
      tone: 'danger',
    })
    if (!shouldDisconnect) return

    setBusyClientId(client.id)
    setError('')
    try {
      await disconnectRecipeOauth(recipeName, client.id)
      showToast(`${client.provider} disconnected.`, { tone: 'success' })
      await loadStatuses()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to disconnect ${client.provider}`)
    } finally {
      setBusyClientId(null)
    }
  }

  function getUserGrantsState(clientId: string): UserGrantsRowState {
    return (
      userGrantsMap[clientId] ?? {
        loadState: 'idle',
        users: [],
        expanded: false,
        busyUserId: null,
      }
    )
  }

  const defaultUserGrantsRowState: UserGrantsRowState = {
    loadState: 'idle',
    users: [],
    expanded: false,
    busyUserId: null,
  }

  function setUserGrantsState(clientId: string, patch: Partial<UserGrantsRowState>) {
    setUserGrantsMap(prev => ({
      ...prev,
      [clientId]: { ...(prev[clientId] ?? defaultUserGrantsRowState), ...patch },
    }))
  }

  async function loadUserGrants(client: OAuthClient) {
    if (!recipeName) return
    setUserGrantsState(client.id, { loadState: 'loading', expanded: true })
    try {
      const { users } = await adminListUserGrants(recipeName, client.id)
      setUserGrantsState(client.id, { loadState: 'ready', users })
    } catch {
      setUserGrantsState(client.id, { loadState: 'error' })
    }
  }

  async function toggleUserGrants(client: OAuthClient) {
    const current = getUserGrantsState(client.id)
    if (current.expanded) {
      setUserGrantsState(client.id, { expanded: false })
    } else {
      await loadUserGrants(client)
    }
  }

  async function handleRevokeUserGrant(client: OAuthClient, userId: string) {
    const shouldRevoke = await confirm({
      title: 'Force-Revoke User Grant',
      message: `Remove ${userId}'s access to ${client.provider} for recipe "${recipeName}"? The user will need to reconnect if they want to use this integration again.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!shouldRevoke) return

    setUserGrantsState(client.id, { busyUserId: userId })
    try {
      await adminRevokeUserGrant(recipeName, client.id, userId)
      await loadUserGrants(client)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke user grant')
      setUserGrantsState(client.id, { busyUserId: null })
    }
  }

  return (
    <div className="cu-card">
      <TablePanelHeader
        title={loading && rows.length === 0 ? 'Integrations' : `Integrations (${clients.length})`}
        subtitle={
          <>
            OAuth providers this recipe can use from background workloads (
            <code>backgroundAccess: true</code>). Connecting creates a recipe-owned grant — no end
            user is involved.
          </>
        }
        actions={
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={() => void loadStatuses()}
            disabled={loading}
            aria-label={loading ? 'Refreshing…' : 'Reload integration status'}
          >
            <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
          </button>
        }
      />

      {error ? (
        <div className="cu-banner cu-banner--error" style={{ padding: '0.85rem 1rem 0' }}>
          {error}
        </div>
      ) : null}
      {clients.length === 0 ? (
        <div className="cu-empty">
          This recipe declares no <code>oauthClients</code> with <code>backgroundAccess: true</code>
          .
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Provider</th>
                <th>Status</th>
                <th style={{ width: '12rem', textAlign: 'right' }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ client, state }) => {
                const busy = busyClientId === client.id
                const ugState = getUserGrantsState(client.id)
                return (
                  <Fragment key={client.id}>
                    <tr>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{client.id}</td>
                      <td>{client.provider}</td>
                      <td>
                        <span
                          className="cu-chip"
                          style={
                            state === 'connected'
                              ? {
                                  color: 'var(--cu-ok-text, var(--cu-text))',
                                  borderColor: 'var(--cu-ok-border, var(--cu-border-subtle))',
                                }
                              : {
                                  color: 'var(--cu-text-soft)',
                                  borderColor: 'var(--cu-border-subtle)',
                                }
                          }
                        >
                          {state === 'connected'
                            ? 'Connected'
                            : state === 'disconnected'
                              ? 'Not connected'
                              : 'Unknown'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{ display: 'inline-flex', gap: '0.5rem' }}>
                          <button
                            type="button"
                            className="cu-btn cu-btn--ghost cu-btn--sm"
                            onClick={() => void toggleUserGrants(client)}
                            disabled={!recipeName}
                            aria-expanded={ugState.expanded}
                          >
                            {ugState.expanded ? 'Hide users' : 'Show users'}
                          </button>
                          {state === 'connected' ? (
                            <button
                              type="button"
                              className="cu-btn cu-btn--ghost cu-btn--sm"
                              onClick={() => void handleDisconnect(client)}
                              disabled={busy}
                            >
                              {busy ? 'Working…' : 'Disconnect'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="cu-btn cu-btn--primary cu-btn--sm"
                              onClick={() => void handleConnect(client)}
                              disabled={busy || !recipeName}
                            >
                              {busy ? 'Working…' : `Connect ${client.provider}`}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {ugState.expanded && (
                      <tr key={`${client.id}--user-grants`}>
                        <td colSpan={4} style={{ padding: '0 1rem 0.75rem 2rem' }}>
                          <div
                            style={{
                              borderLeft: '2px solid var(--cu-border-subtle)',
                              paddingLeft: '0.75rem',
                            }}
                          >
                            <div
                              style={{
                                fontSize: '0.78rem',
                                fontWeight: 600,
                                color: 'var(--cu-text-soft)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                                marginBottom: '0.4rem',
                              }}
                            >
                              Per-user connections
                            </div>
                            {ugState.loadState === 'loading' && (
                              <div className="cu-empty" style={{ paddingTop: 0 }}>
                                Loading…
                              </div>
                            )}
                            {ugState.loadState === 'error' && (
                              <div
                                className="cu-banner cu-banner--error"
                                style={{ margin: '0.25rem 0' }}
                              >
                                Could not load user grants.
                              </div>
                            )}
                            {ugState.loadState === 'ready' && ugState.users.length === 0 && (
                              <div className="cu-empty" style={{ paddingTop: 0 }}>
                                No user grants for this client.
                              </div>
                            )}
                            {ugState.loadState === 'ready' && ugState.users.length > 0 && (
                              <table
                                className="cu-table"
                                style={{ fontSize: '0.82rem', marginTop: 0 }}
                              >
                                <thead>
                                  <tr>
                                    <th>User ID</th>
                                    <th>Type</th>
                                    <th>Granted</th>
                                    <th
                                      style={{ width: '8rem', textAlign: 'right' }}
                                      aria-label="Actions"
                                    />
                                  </tr>
                                </thead>
                                <tbody>
                                  {ugState.users.map(u => {
                                    const userBusy = ugState.busyUserId === u.userId
                                    return (
                                      <tr key={u.userId}>
                                        <td style={{ fontFamily: 'monospace' }}>{u.userId}</td>
                                        <td>
                                          <span className="cu-chip">
                                            {u.background ? 'background' : 'interactive'}
                                          </span>
                                        </td>
                                        <td style={{ color: 'var(--cu-text-soft)' }}>
                                          {new Date(u.updatedAt).toLocaleDateString()}
                                        </td>
                                        <td style={{ textAlign: 'right' }}>
                                          <button
                                            type="button"
                                            className="cu-btn cu-btn--ghost cu-btn--sm"
                                            disabled={userBusy}
                                            onClick={() =>
                                              void handleRevokeUserGrant(client, u.userId)
                                            }
                                          >
                                            {userBusy ? 'Working…' : 'Revoke'}
                                          </button>
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            )}
                            <div style={{ marginTop: '0.4rem' }}>
                              <button
                                type="button"
                                className="cu-btn cu-btn--ghost cu-btn--sm"
                                onClick={() => void loadUserGrants(client)}
                                disabled={ugState.loadState === 'loading'}
                                aria-label="Refresh user grants"
                              >
                                <IconRefresh
                                  className={
                                    ugState.loadState === 'loading' ? 'cu-spin' : undefined
                                  }
                                  width={14}
                                  height={14}
                                />
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirmDialog}
    </div>
  )
}
