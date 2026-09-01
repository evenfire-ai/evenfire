'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DataTable } from '@clerum/frontend-components'
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
import { RowActionsMenu } from '../RowActionsMenu'
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
  const [activeGrantsClientId, setActiveGrantsClientId] = useState<string | null>(null)
  const grantsDialogRef = useRef<HTMLElement>(null)
  const grantsCloseButtonRef = useRef<HTMLButtonElement>(null)
  const grantsOpenerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!activeGrantsClientId) return
    grantsCloseButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setActiveGrantsClientId(null)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        grantsDialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const opener = grantsOpenerRef.current
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
  }, [activeGrantsClientId])

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
        busyUserId: null,
      }
    )
  }

  const defaultUserGrantsRowState: UserGrantsRowState = {
    loadState: 'idle',
    users: [],
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
    setActiveGrantsClientId(client.id)
    setUserGrantsState(client.id, { loadState: 'loading' })
    try {
      const { users } = await adminListUserGrants(recipeName, client.id)
      setUserGrantsState(client.id, { loadState: 'ready', users })
    } catch {
      setUserGrantsState(client.id, { loadState: 'error' })
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
        refreshAction={
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
        <div className="eft-table-viewport cu-table-wrap">
          <DataTable className="eft-table cu-table">
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
                return (
                  <tr key={client.id}>
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
                    <td className="cu-table__cell-actions">
                      <span
                        onFocusCapture={event => {
                          grantsOpenerRef.current = event.target as HTMLElement
                        }}
                      >
                        <RowActionsMenu
                          ariaLabel={`Actions for ${client.id}`}
                          actions={[
                            {
                              key: 'user-grants',
                              label: 'Manage user grants',
                              disabled: !recipeName,
                              onClick: () => void loadUserGrants(client),
                            },
                            state === 'connected'
                              ? {
                                  key: 'disconnect',
                                  label: busy ? 'Working…' : 'Disconnect',
                                  danger: true,
                                  disabled: busy,
                                  onClick: () => void handleDisconnect(client),
                                }
                              : {
                                  key: 'connect',
                                  label: busy ? 'Working…' : `Connect ${client.provider}`,
                                  disabled: busy || !recipeName,
                                  onClick: () => void handleConnect(client),
                                },
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
      )}
      {activeGrantsClientId
        ? (() => {
            const client = clients.find(candidate => candidate.id === activeGrantsClientId)
            if (!client) return null
            const grants = getUserGrantsState(client.id)
            return (
              <div
                className="cu-modal-backdrop"
                role="presentation"
                onClick={event => {
                  if (event.target === event.currentTarget && !grants.busyUserId) {
                    setActiveGrantsClientId(null)
                  }
                }}
              >
                <section
                  aria-labelledby="recipe-user-grants-title"
                  aria-modal="true"
                  className="cu-modal-panel cu-modal-panel--selection"
                  ref={grantsDialogRef}
                  role="dialog"
                >
                  <div className="cu-modal-panel__head">
                    <div>
                      <h3 className="cu-modal-panel__title" id="recipe-user-grants-title">
                        Per-user connections
                      </h3>
                      <p className="cu-muted">
                        {client.provider} grants for client <code>{client.id}</code>
                      </p>
                    </div>
                    <button
                      aria-label="Close user grants"
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      disabled={Boolean(grants.busyUserId)}
                      onClick={() => setActiveGrantsClientId(null)}
                      ref={grantsCloseButtonRef}
                      type="button"
                    >
                      Close
                    </button>
                  </div>
                  {grants.loadState === 'loading' ? <div className="cu-empty">Loading…</div> : null}
                  {grants.loadState === 'error' ? (
                    <div className="cu-banner cu-banner--error">Could not load user grants.</div>
                  ) : null}
                  {grants.loadState === 'ready' && grants.users.length === 0 ? (
                    <div className="cu-empty">No user grants for this client.</div>
                  ) : null}
                  {grants.loadState === 'ready' && grants.users.length > 0 ? (
                    <div className="eft-table-viewport cu-table-wrap">
                      <DataTable className="eft-table cu-table" variant="embedded">
                        <thead>
                          <tr>
                            <th>User ID</th>
                            <th>Type</th>
                            <th>Granted</th>
                            <th aria-label="Actions" />
                          </tr>
                        </thead>
                        <tbody>
                          {grants.users.map(user => {
                            const userBusy = grants.busyUserId === user.userId
                            return (
                              <tr key={user.userId}>
                                <td className="cu-code-text">{user.userId}</td>
                                <td>{user.background ? 'Background' : 'Interactive'}</td>
                                <td>{new Date(user.updatedAt).toLocaleDateString()}</td>
                                <td className="cu-table__cell-actions">
                                  <RowActionsMenu
                                    ariaLabel={`Actions for user ${user.userId}`}
                                    actions={[
                                      {
                                        key: 'revoke',
                                        label: userBusy ? 'Working…' : 'Revoke',
                                        danger: true,
                                        disabled: userBusy,
                                        onClick: () =>
                                          void handleRevokeUserGrant(client, user.userId),
                                      },
                                    ]}
                                  />
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </DataTable>
                    </div>
                  ) : null}
                  <div className="cu-create-actions">
                    <button
                      className="cu-btn cu-btn--secondary cu-btn--sm"
                      disabled={grants.loadState === 'loading'}
                      onClick={() => void loadUserGrants(client)}
                      type="button"
                    >
                      <IconRefresh
                        className={grants.loadState === 'loading' ? 'cu-spin' : undefined}
                        height={14}
                        width={14}
                      />
                      Refresh
                    </button>
                  </div>
                </section>
              </div>
            )
          })()
        : null}
      {confirmDialog}
    </div>
  )
}
