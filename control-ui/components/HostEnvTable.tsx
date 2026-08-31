'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { DataTable } from '@clerum/frontend-table-system'
import {
  HostEnvEntry,
  HostEnvWriteResult,
  deleteHostEnvKey,
  listHostEnv,
  putHostEnv,
} from '../lib/api'
import { useConfirmDialog } from './ConfirmDialog'
import { useToast } from './Toast'
import { IconPencil, IconRefresh, IconX } from './icons'
import { Button, CheckboxField, Field, TextInput } from './ui'

const RESERVED_PROVIDER_KEYS = new Set([
  'OPENAI_API_KEY',
  'CLAUDE_API_KEY',
  'ZAI_API_KEY',
  'BAILIAN_API_KEY',
])

const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/

/**
 * Validate a key name client-side. Returns an error message or null when OK.
 * The backend revalidates and is the source of truth — this is just for fast
 * inline feedback in the form.
 */
function validateKey(name: string): string | null {
  if (!name) return 'Name is required.'
  if (!KEY_NAME_RE.test(name)) {
    return 'Use uppercase shell-style names: [A-Z][A-Z0-9_]* (e.g. GITHUB_TOKEN).'
  }
  if (RESERVED_PROVIDER_KEYS.has(name)) {
    return `${name} is reserved — manage provider keys via the LLM Secrets tab.`
  }
  if (name.startsWith('CLERUM_')) {
    return 'CLERUM_* is reserved for infrastructure variables. Pick another prefix.'
  }
  return null
}

export function HostEnvTable({ hostRef }: { hostRef: string }) {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [items, setItems] = useState<HostEnvEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  // Add-or-edit form state
  const [open, setOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [valueDraft, setValueDraft] = useState('')
  const [secretDraft, setSecretDraft] = useState(false)
  const [keyDraftError, setKeyDraftError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Show-once panel state
  const [showOnce, setShowOnce] = useState<Record<string, string> | null>(null)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())

  // Delete confirmation
  const [deletingKey, setDeletingKey] = useState<string | null>(null)

  const sortedItems = useMemo(() => [...items].sort((a, b) => a.key.localeCompare(b.key)), [items])

  async function load(opts: { refresh?: boolean } = {}) {
    if (opts.refresh) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const res = await listHostEnv(hostRef)
      setItems(res.items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef])

  function openCreate() {
    setEditingKey(null)
    setKeyDraft('')
    setValueDraft('')
    setSecretDraft(false)
    setKeyDraftError(null)
    setOpen(true)
  }

  function openEdit(entry: HostEnvEntry) {
    setEditingKey(entry.key)
    setKeyDraft(entry.key)
    setValueDraft('')
    setSecretDraft(entry.secret)
    setKeyDraftError(null)
    setOpen(true)
  }

  function closeForm() {
    setOpen(false)
    setEditingKey(null)
    setKeyDraft('')
    setValueDraft('')
    setSecretDraft(false)
    setKeyDraftError(null)
  }

  async function save() {
    const finalKey = (editingKey ?? keyDraft).trim()
    const validationError = validateKey(finalKey)
    if (validationError) {
      setKeyDraftError(validationError)
      return
    }
    if (!valueDraft) {
      setKeyDraftError('Value is required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result: HostEnvWriteResult = await putHostEnv(hostRef, [
        { key: finalKey, value: valueDraft, secret: secretDraft },
      ])
      setItems(result.keys)
      if (result.showOnce && Object.keys(result.showOnce).length > 0) {
        setShowOnce(result.showOnce)
        setRevealedKeys(new Set())
      }
      closeForm()
      showToast('Applied within ~1 second.', { tone: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete(key: string) {
    const shouldDelete = await confirm({
      title: 'Delete Environment Variable',
      message: `Delete environment variable ${key}? If a default exists in process.env, it may reappear.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setDeletingKey(key)
    setError('')
    try {
      await deleteHostEnvKey(hostRef, key)
      setItems(prev => prev.filter(i => i.key !== key))
      showToast(`Deleted ${key}.`, { tone: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingKey(null)
    }
  }

  function toggleReveal(k: string) {
    setRevealedKeys(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      showToast('Copied to clipboard.', { tone: 'success' })
    } catch {
      setError('Could not copy to clipboard. Select and copy manually.')
    }
  }

  return (
    <section className="cu-host-env-tab">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        <div>
          <p className="cu-muted" style={{ margin: 0, fontSize: '0.85rem' }}>
            Operator-managed env vars for this Host. Applied within ~1 second; no pod restart.
            Provider keys live in the LLM Secrets tab.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--toolbar"
            onClick={() => load({ refresh: true })}
            disabled={refreshing}
            aria-label={
              refreshing ? 'Refreshing environment variables' : 'Refresh environment variables'
            }
          >
            <IconRefresh className={refreshing ? 'cu-spin' : undefined} />
          </button>
          <button type="button" className="cu-btn cu-btn--primary" onClick={openCreate}>
            + Add variable
          </button>
        </div>
      </div>

      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

      {showOnce ? (
        <div className="cu-banner cu-banner--warn" data-testid="host-env-show-once">
          <strong>This is the only time these values will be displayed.</strong> After dismissal,
          secrets become unretrievable — copy them now.
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1rem' }}>
            {Object.entries(showOnce).map(([k, v]) => (
              <li key={k} style={{ marginBottom: '0.25rem' }}>
                <code>{k}</code>
                {' = '}
                {revealedKeys.has(k) ? <code>{v}</code> : <code>••••••••</code>}{' '}
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  onClick={() => toggleReveal(k)}
                >
                  {revealedKeys.has(k) ? 'Hide' : 'Reveal'}
                </button>{' '}
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  onClick={() => copyToClipboard(v)}
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() => setShowOnce(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <DataTable className="eft-table cu-table" data-testid="host-env-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Last updated</th>
            <th style={{ width: '8rem' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={4} className="cu-empty">
                Loading…
              </td>
            </tr>
          ) : sortedItems.length === 0 ? (
            <tr>
              <td colSpan={4} className="cu-empty">
                No env vars set for this Host yet.
              </td>
            </tr>
          ) : (
            sortedItems.map(entry => (
              <tr key={entry.key}>
                <td>
                  <code>{entry.key}</code>
                </td>
                <td>{entry.secret ? 'Secret' : 'Non-secret'}</td>
                <td>{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '—'}</td>
                <td>
                  <button
                    type="button"
                    className="cu-btn cu-btn--icon cu-btn--toolbar"
                    onClick={() => openEdit(entry)}
                    aria-label={`Edit ${entry.key}`}
                    title={`Edit ${entry.key}`}
                  >
                    <IconPencil width={16} height={16} />
                  </button>{' '}
                  <button
                    type="button"
                    className="cu-btn cu-btn--icon cu-btn--danger-icon"
                    onClick={() => void confirmDelete(entry.key)}
                    disabled={deletingKey === entry.key}
                    aria-label={`Delete ${entry.key}`}
                    title={`Delete ${entry.key}`}
                  >
                    <IconX width={16} height={16} />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </DataTable>

      {open ? (
        <section className="cu-host-env-form" data-testid="host-env-form">
          <div className="cu-host-env-form__head">
            <div>
              <h3 className="cu-host-env-form__title">
                {editingKey ? `Edit ${editingKey}` : 'Add variable'}
              </h3>
              <p className="cu-host-env-form__description">
                {editingKey
                  ? 'Update the value applied to this agent.'
                  : 'Create an operator-managed variable for this agent.'}
              </p>
            </div>
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={closeForm}
              aria-label="Close variable form"
            >
              <IconX width={16} height={16} />
            </button>
          </div>

          <div className="cu-host-env-form__grid">
            <Field
              error={keyDraftError}
              htmlFor="host-env-key"
              label="Name"
              description="Use uppercase shell-style names such as GITHUB_TOKEN."
              required
            >
              <TextInput
                id="host-env-key"
                type="text"
                value={keyDraft}
                disabled={!!editingKey}
                onChange={e => {
                  setKeyDraft(e.target.value)
                  setKeyDraftError(validateKey(e.target.value.trim()))
                }}
                placeholder="GITHUB_TOKEN"
              />
            </Field>

            <Field htmlFor="host-env-value" label="Value" required>
              <TextInput
                id="host-env-value"
                type={secretDraft ? 'password' : 'text'}
                value={valueDraft}
                onChange={e => setValueDraft(e.target.value)}
                placeholder={secretDraft ? 'sek-rit' : 'value'}
              />
            </Field>

            <CheckboxField
              checked={secretDraft}
              onChange={e => setSecretDraft(e.target.checked)}
              disabled={!!editingKey}
              label="Secret"
              description="Stored in a Kubernetes Secret and never returned by GET."
            />
          </div>

          <div className="cu-host-env-form__actions">
            <Button type="button" variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </section>
      ) : null}

      {confirmDialog}
    </section>
  )
}
