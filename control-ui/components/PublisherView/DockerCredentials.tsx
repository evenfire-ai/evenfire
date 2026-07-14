'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  type CreatedRegistryApiKey,
  type RegistryApiKey,
  createRegistryApiKey,
  listRegistryApiKeys,
  revokeRegistryApiKey,
} from '../../lib/api'
import { useConfirmDialog } from '../ConfirmDialog'
import { TableHeaderRow } from '../TableHeaderRow'
import type { TableHeaderColumn } from '../TableHeaderRow/types'
import { useToast } from '../Toast'
import { Button } from '../ui'
import { DockerCredentialModal } from './DockerCredentialModal'
import { RetryBanner } from './RetryBanner'

// Mirrors RegistryApiKeysPanel's state machine: the org registry-keys route is
// user+owner-gated, so a non-owner admin on an org-bound deploy (Publisher is
// gated on the *deploy*, not per-user ownership) gets a 403 and must see an
// actionable message rather than an infinite "Retry".
type View =
  | { kind: 'loading' }
  | { kind: 'ready'; org: string; keys: RegistryApiKey[] }
  | { kind: 'not-owner'; org?: string }
  | { kind: 'no-org' }
  | { kind: 'auth-disabled' }
  | { kind: 'unavailable' }
  | { kind: 'error' }

const COLUMNS: TableHeaderColumn[] = [
  { key: 'prefix', label: 'Prefix' },
  { key: 'description', label: 'Description' },
  { key: 'created', label: 'Created' },
  { key: 'expires', label: 'Expires' },
  { key: 'actions', ariaLabel: 'Actions', align: 'right' },
]

function fmtExpiry(v: string | null): string {
  if (!v) return 'Never'
  const d = new Date(v)
  return d.getTime() < Date.now() ? `Expired ${d.toLocaleDateString()}` : d.toLocaleString()
}

function generateErrorMessage(err: unknown): string {
  const code = (err as { code?: string }).code
  const status = (err as { status?: number }).status
  if (status === 429) return 'Too many requests — try again shortly.'
  if (status === 403) return 'You must be an org owner to generate push credentials.'
  if (code === 'too_many_keys') return 'You have reached the key limit. Revoke an unused key first.'
  if (code === 'registry_self_service_unavailable')
    return 'Push credentials are not available on this deployment.'
  return 'Could not generate the credential. Please try again.'
}

export function DockerCredentialsPanel({ orgScope }: { orgScope: string }) {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [formError, setFormError] = useState('')
  const [revealed, setRevealed] = useState<CreatedRegistryApiKey | null>(null)

  const load = useCallback(async () => {
    setView({ kind: 'loading' })
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
      else if (status === 400 && code === 'registry_self_service_unavailable')
        setView({ kind: 'unavailable' })
      else setView({ kind: 'error' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const isReady = view.kind === 'ready'

  async function handleGenerate() {
    if (generating) return
    setGenerating(true)
    setFormError('')
    try {
      const body = description.trim() ? { description: description.trim() } : {}
      const created = await createRegistryApiKey(body)
      setDescription('')
      setRevealed(created)
      await load()
    } catch (err) {
      setFormError(generateErrorMessage(err))
    } finally {
      setGenerating(false)
    }
  }

  async function handleRevoke(k: RegistryApiKey) {
    const ok = await confirm({
      title: 'Revoke push credential',
      message: `Revoke ${k.key_prefix}${k.description ? ` ("${k.description}")` : ''}? Any CI using it stops pushing on its next request. This cannot be undone.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await revokeRegistryApiKey(k.id)
      showToast(`Revoked ${k.key_prefix}.`, { tone: 'success' })
    } catch (err) {
      const status = (err as { status?: number }).status
      showToast(status === 404 ? 'Key was already revoked.' : 'Could not revoke the key.', {
        tone: status === 404 ? 'info' : 'error',
      })
    }
    await load()
  }

  return (
    <div className="cu-card__body">
      <p className="cu-field__hint">
        Generate a durable credential to <code>docker push</code> images to{' '}
        <code>example.com/{orgScope}/…</code>. Keys are listable and revocable for CI
        hygiene.
      </p>

      {isReady ? (
        <>
          <div className="cu-form-inline">
            <div className="cu-field">
              <label htmlFor="push-cred-desc">Description (optional)</label>
              <input
                id="push-cred-desc"
                className="cu-input"
                maxLength={200}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="e.g. GitHub Actions push"
              />
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={generating}
              onClick={() => void handleGenerate()}
            >
              {generating ? 'Generating…' : 'Generate push credential'}
            </Button>
          </div>
          {formError ? (
            <p className="cu-field__error" role="alert">
              {formError}
            </p>
          ) : null}
        </>
      ) : null}

      {view.kind === 'loading' ? <p>Loading…</p> : null}
      {view.kind === 'not-owner' ? (
        <p className="cu-banner cu-banner--warn">
          You must be an org owner to manage push credentials
          {view.org ? ` for @${view.org}` : ''}.
        </p>
      ) : null}
      {view.kind === 'no-org' ? (
        <p className="cu-banner cu-banner--warn">
          This deployment is not bound to a registry org, so there are no push credentials to
          manage.
        </p>
      ) : null}
      {view.kind === 'auth-disabled' ? (
        <p className="cu-banner">Registry authentication is disabled in this environment.</p>
      ) : null}
      {view.kind === 'unavailable' ? (
        <p className="cu-banner cu-banner--warn">
          Push credentials are not available on this deployment.
        </p>
      ) : null}
      {view.kind === 'error' ? (
        <RetryBanner message="Could not load credentials." onRetry={() => void load()} />
      ) : null}

      {isReady ? (
        view.keys.length === 0 ? (
          <p>No push credentials yet.</p>
        ) : (
          <div className="cu-table-wrap">
            <table className="cu-table">
              <thead>
                <TableHeaderRow columns={COLUMNS} />
              </thead>
              <tbody>
                {view.keys.map(k => (
                  <tr key={k.id}>
                    <td>
                      <code>{k.key_prefix}</code>
                    </td>
                    <td>{k.description || '—'}</td>
                    <td title={k.created_at}>{new Date(k.created_at).toLocaleString()}</td>
                    <td>{fmtExpiry(k.expires_at)}</td>
                    <td style={{ textAlign: 'right' }}>
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

      {revealed ? (
        <DockerCredentialModal
          created={revealed}
          orgScope={orgScope}
          onClose={() => setRevealed(null)}
        />
      ) : null}
      {confirmDialog}
    </div>
  )
}
