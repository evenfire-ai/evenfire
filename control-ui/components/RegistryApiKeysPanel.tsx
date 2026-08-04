'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type CreateRegistryApiKeyInput,
  type CreatedRegistryApiKey,
  type RegistryApiKey,
  createRegistryApiKey,
  getRegistryConnection,
  listRegistryApiKeys,
  revokeRegistryApiKey,
} from '../lib/api'
import { useConfirmDialog } from './ConfirmDialog'
import CreateApiKeyModal from './CreateApiKeyModal'
import RevealApiKeyModal from './RevealApiKeyModal'
import { SectionLoadingSkeleton } from './SectionLoadingSkeleton'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { useToast } from './Toast'
import { Button } from './ui'

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; org: string; keys: RegistryApiKey[] }
  | { kind: 'not-owner'; org?: string }
  | { kind: 'no-org' }
  | { kind: 'auth-disabled' }
  | { kind: 'url-not-configured' }
  | { kind: 'error' }

const API_KEYS_COLUMNS: TableHeaderColumn[] = [
  { key: 'prefix', label: 'Prefix' },
  { key: 'description', label: 'Description' },
  { key: 'scopes', label: 'Scopes' },
  { key: 'created_by', label: 'Created by' },
  { key: 'created', label: 'Created' },
  { key: 'expires', label: 'Expires' },
  { key: 'last_used', label: 'Last used' },
  { key: 'actions', ariaLabel: 'Actions', align: 'right' },
]

function fmtTime(v: string | null, neverLabel: string): string {
  if (!v) return neverLabel
  return new Date(v).toLocaleString()
}
function fmtExpiry(v: string | null): string {
  if (!v) return 'Never'
  const d = new Date(v)
  return d.getTime() < Date.now() ? `Expired ${d.toLocaleDateString()}` : d.toLocaleString()
}

export default function RegistryApiKeysPanel() {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState<CreatedRegistryApiKey | null>(null)
  // The auth-disabled view needs mode-specific copy: self-hosted fixes it by
  // connecting, managed fixes it via CLERUM_REGISTRY_AUTH_ENABLED (no connect
  // flow exists there). Same best-effort detection RegistryCatalog uses for its
  // Connect button — getRegistryConnection() 409s not_self_hosted in managed
  // mode. Fail-open to 'self-hosted' (treat 'unknown' like RegistryCatalog does
  // via its `!== 'managed'` check) since a transient error here is far more
  // likely than a real managed deployment misreporting its own mode.
  const [connectionMode, setConnectionMode] = useState<'self-hosted' | 'managed' | 'unknown'>(
    'unknown'
  )

  const load = useCallback(async () => {
    try {
      const { org, keys } = await listRegistryApiKeys()
      const sorted = [...keys].sort((a, b) => b.created_at.localeCompare(a.created_at))
      setView({ kind: 'ready', org, keys: sorted })
    } catch (e) {
      const status = (e as { status?: number }).status
      const code = (e as { code?: string }).code
      if (status === 403) setView({ kind: 'not-owner', org: (e as { org?: string }).org })
      else if (status === 409 && code === 'no_org') setView({ kind: 'no-org' })
      else if (status === 409 && code === 'registry_auth_disabled')
        setView({ kind: 'auth-disabled' })
      else if (status === 409 && code === 'registry_url_not_configured')
        setView({ kind: 'url-not-configured' })
      else setView({ kind: 'error' })
    }
  }, [])

  const loadConnectionMode = useCallback(async () => {
    try {
      await getRegistryConnection()
      setConnectionMode('self-hosted')
    } catch (e) {
      setConnectionMode((e as { code?: string }).code === 'not_self_hosted' ? 'managed' : 'unknown')
    }
  }, [])

  useEffect(() => {
    void load()
    void loadConnectionMode()
  }, [load, loadConnectionMode])

  async function handleCreate(input: CreateRegistryApiKeyInput) {
    const created: CreatedRegistryApiKey = await createRegistryApiKey(input)
    setCreating(false)
    setRevealed(created)
    await load()
  }

  async function handleRevoke(k: RegistryApiKey) {
    const ok = await confirm({
      title: 'Revoke API key',
      message: `Revoke ${k.key_prefix}${k.description ? ` ("${k.description}")` : ''}? Any service using it stops publishing on its next request. This cannot be undone.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await revokeRegistryApiKey(k.id)
      showToast(`Revoked ${k.key_prefix}.`, { tone: 'success' })
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 429) {
        showToast('Too many requests — try again shortly.', { tone: 'error' })
      } else {
        showToast(status === 404 ? 'Key was already revoked.' : 'Could not revoke the key.', {
          tone: status === 404 ? 'info' : 'error',
        })
      }
    }
    await load()
  }

  const isReady = view.kind === 'ready'

  const content = (
    <>
      <TablePanelHeader
        title={`API keys${isReady ? ` for @${(view as { org: string }).org}` : ''}`}
        actions={
          isReady ? (
            <Button type="button" variant="primary" size="sm" onClick={() => setCreating(true)}>
              + Create key
            </Button>
          ) : null
        }
      />

      <div className="cu-card__body">
        {view.kind === 'loading' ? (
          <SectionLoadingSkeleton label="Loading registry API keys" />
        ) : null}
        {view.kind === 'not-owner' ? (
          <p className="cu-banner cu-banner--warn">
            You must be an org owner to manage API keys
            {view.org ? ` for @${view.org}` : ''}.
          </p>
        ) : null}
        {view.kind === 'no-org' ? (
          <p className="cu-banner cu-banner--warn">
            This deployment is not bound to a registry org, so there are no org API keys to manage.
          </p>
        ) : null}
        {view.kind === 'auth-disabled' ? (
          <p className="cu-banner cu-banner--info">
            {connectionMode === 'managed' ? (
              <>
                Registry authentication for this deployment is controlled by{' '}
                <code>CLERUM_REGISTRY_AUTH_ENABLED</code>. An operator must enable it and restart
                control-api before API keys can be created here.
              </>
            ) : (
              <>
                API keys become available once this deployment is connected to the registry.{' '}
                <Link href={CONTROL_ROUTES.marketplace.connect}>Connect to Evenfire Registry</Link>.
              </>
            )}
          </p>
        ) : null}
        {view.kind === 'url-not-configured' ? (
          <p className="cu-banner cu-banner--warn">
            This deployment still holds registry credentials, but <code>CLERUM_REGISTRY_URL</code>{' '}
            is not configured. Restore the registry URL or disconnect the stale connection before
            managing API keys.
          </p>
        ) : null}
        {view.kind === 'error' ? (
          <p className="cu-banner cu-banner--warn">
            Could not load API keys.{' '}
            <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </p>
        ) : null}

        {view.kind === 'ready' ? (
          view.keys.length === 0 ? (
            <p>No API keys yet. Create one to publish to @{view.org} from CI or scripts.</p>
          ) : (
            <div className="cu-table-wrap">
              <table className="cu-table">
                <thead>
                  <TableHeaderRow columns={API_KEYS_COLUMNS} />
                </thead>
                <tbody>
                  {view.keys.map(k => (
                    <tr key={k.id}>
                      <td>
                        <code>{k.key_prefix}</code>
                      </td>
                      <td>{k.description || '—'}</td>
                      <td>{k.scopes.join(', ')}</td>
                      <td>{k.created_by_username}</td>
                      <td title={k.created_at}>{fmtTime(k.created_at, '—')}</td>
                      <td>{fmtExpiry(k.expires_at)}</td>
                      <td>{fmtTime(k.last_used_at, 'Never used')}</td>
                      <td>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          onClick={() => void handleRevoke(k)}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </div>
    </>
  )

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">{content}</div>
      {creating ? (
        <CreateApiKeyModal onCreate={handleCreate} onCancel={() => setCreating(false)} />
      ) : null}
      {revealed ? (
        <RevealApiKeyModal
          created={revealed}
          orgScope={view.kind === 'ready' ? view.org : ''}
          onClose={() => setRevealed(null)}
        />
      ) : null}
      {confirmDialog}
    </section>
  )
}
