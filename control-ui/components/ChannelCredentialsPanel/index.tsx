'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck, IconPencil, IconTrash } from '@components/icons'
import { cn } from '@lib/cn'
import { apiSend } from '../../lib/api'
import { useToast } from '../Toast'
import { CHANNEL_CREDENTIAL_FIELDS } from './constants'
import type { ChannelCredentialsPanelProps, CredentialDraft } from './types'

function emptyDraft(): CredentialDraft {
  return {}
}

type SaveStatus = 'idle' | 'saved' | 'error'

/**
 * Per-CommunicationChannel provider credential form.
 *
 * Backed by `PUT /api/v1/admin/communication-channels/:name/credentials` for
 * existing CCs (write-only rotation — the API never returns stored values).
 * For new CCs (`pending=true`), the panel buffers values via `onPendingChange`
 * so the parent can post them as a `credentials` block on the CC create call;
 * control-api atomically creates the Secret and CC in the same handler.
 *
 * Empty fields are NOT sent on rotation: a partial update of just the
 * Telegram token must not clobber the stored Slack token. Only non-empty
 * trimmed values make it into the request body.
 */
export function ChannelCredentialsPanel({
  ccName,
  pending,
  onPendingChange,
  hasStoredCredentials = false,
  presentation = 'panel',
  readOnly = false,
  visibleChannelTypes,
}: ChannelCredentialsPanelProps) {
  const { showToast } = useToast()
  const [draft, setDraft] = useState<CredentialDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState('')
  const [editingKeys, setEditingKeys] = useState<Partial<Record<keyof CredentialDraft, boolean>>>(
    {}
  )
  const [deletedKeys, setDeletedKeys] = useState<Partial<Record<keyof CredentialDraft, boolean>>>(
    {}
  )

  // Monotonic id to drop stale async responses when `ccName` changes mid-flight.
  const requestId = useRef(0)

  // Filter the static field list by `visibleChannelTypes` when provided.
  // Undefined → show all (rotation back-compat); empty array → render nothing.
  // Stable signature lets effects below skip work when the set is unchanged.
  const visibleSignature = visibleChannelTypes ? [...visibleChannelTypes].sort().join('|') : null
  const fields = useMemo(() => {
    if (!visibleChannelTypes) return CHANNEL_CREDENTIAL_FIELDS
    const allowed = new Set(visibleChannelTypes)
    return CHANNEL_CREDENTIAL_FIELDS.filter(f => allowed.has(f.channelType))
    // visibleSignature stands in for visibleChannelTypes — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSignature])

  // Reset local state when the target CC changes so values typed for CC A
  // are not saved against CC B if the parent swaps `ccName` without unmounting.
  useEffect(() => {
    setDraft(emptyDraft())
    setError('')
    setStatus('idle')
    setEditingKeys({})
    setDeletedKeys({})
    requestId.current += 1
  }, [ccName, hasStoredCredentials])

  // Prune draft values for channel types that are no longer visible. Prevents
  // a stale token (e.g., user typed Slack creds then removed the Slack row)
  // from leaking into the POST body on submit.
  useEffect(() => {
    if (visibleSignature === null) return
    const allowed = new Set(visibleChannelTypes)
    setDraft(prev => {
      let changed = false
      const next: CredentialDraft = { ...prev }
      for (const field of CHANNEL_CREDENTIAL_FIELDS) {
        if (!allowed.has(field.channelType) && next[field.key] !== undefined) {
          delete next[field.key]
          changed = true
        }
      }
      return changed ? next : prev
    })
    // visibleSignature drives this effect; visibleChannelTypes is read by ref
    // inside but its identity changes don't matter when the contents are the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSignature])

  // Forward draft to the parent in pending mode so the CC create POST can
  // include the buffered credentials. Effectful only when `pending` is true.
  useEffect(() => {
    if (pending && onPendingChange) onPendingChange(draft)
    // We intentionally omit onPendingChange from deps — callers typically
    // pass an inline arrow; including it would loop. Drafts + pending are
    // the only meaningful change signals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, pending])

  function updateField(key: keyof CredentialDraft, value: string) {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  function editField(key: keyof CredentialDraft) {
    setEditingKeys(prev => ({ ...prev, [key]: true }))
    setDraft(prev => ({ ...prev, [key]: '' }))
    setError('')
    setStatus('idle')
  }

  async function saveField(key: keyof CredentialDraft) {
    const value = (draft[key] || '').trim()
    if (!value) {
      setStatus('error')
      setError('Provide a credential value to save.')
      return
    }
    if (!ccName) {
      setStatus('error')
      setError('Channel name is missing.')
      return
    }

    const id = ++requestId.current
    setSaving(true)
    setStatus('idle')
    setError('')
    try {
      await apiSend(
        'PUT',
        `/api/v1/admin/communication-channels/${encodeURIComponent(ccName)}/credentials`,
        {
          [key]: value,
        }
      )
      if (id !== requestId.current) return
      setDraft(prev => ({ ...prev, [key]: '' }))
      setEditingKeys(prev => ({ ...prev, [key]: false }))
      setDeletedKeys(prev => ({ ...prev, [key]: false }))
      setStatus('saved')
      showToast('Channel credential saved.', { tone: 'success' })
    } catch (e) {
      if (id !== requestId.current) return
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Failed to save credential')
    } finally {
      if (id === requestId.current) setSaving(false)
    }
  }

  async function deleteField(key: keyof CredentialDraft) {
    if (!ccName) {
      setStatus('error')
      setError('Channel name is missing.')
      return
    }

    const id = ++requestId.current
    setSaving(true)
    setStatus('idle')
    setError('')
    try {
      await apiSend(
        'DELETE',
        `/api/v1/admin/communication-channels/${encodeURIComponent(ccName)}/credentials/${encodeURIComponent(key)}`
      )
      if (id !== requestId.current) return
      setDraft(prev => ({ ...prev, [key]: '' }))
      setEditingKeys(prev => ({ ...prev, [key]: false }))
      setDeletedKeys(prev => ({ ...prev, [key]: true }))
      setStatus('saved')
      showToast('Channel credential deleted.', { tone: 'success' })
    } catch (e) {
      if (id !== requestId.current) return
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Failed to delete credential')
    } finally {
      if (id === requestId.current) setSaving(false)
    }
  }

  const disabled = saving
  const fieldsDisabled = disabled || (!pending && !ccName)
  const isInline = presentation === 'inline'

  return (
    <div className={cn('cu-channel-credentials', isInline && 'cu-channel-credentials--inline')}>
      {!isInline && (
        <>
          <div className="cu-channel-credentials__head">
            <p className="cu-section-title cu-channel-credentials__title">Channel credentials</p>
            <ChannelCredentialsBadge status={status} saving={saving} />
          </div>
          <p className="cu-muted cu-channel-credentials__hint">
            Provider credentials for this channel&apos;s channel-reader. Stored as a Kubernetes
            Secret
            <code> cc-{ccName || '<channel>'}-credentials </code>
            in the <code>channels</code> namespace. Values are write-only — fields render blank and
            existing secrets are never returned. The Secret is created on first save and follows the
            CC if you change <code>hostRef</code>.
          </p>
        </>
      )}

      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

      {!pending && !ccName ? (
        <div className="cu-empty">
          Save the channel first, then return here to set its credentials.
        </div>
      ) : (
        <>
          {fields.length === 0 ? (
            <div className="cu-empty">
              Select a communication channel provider to configure its credentials.
            </div>
          ) : (
            <div className="cu-form-stack">
              {fields.map(field => (
                <div key={field.key} className="cu-field cu-field--compact">
                  <label htmlFor={`channel-cred-${field.key}`}>{field.label}</label>
                  <div className="cu-credential-field">
                    <input
                      id={`channel-cred-${field.key}`}
                      type="password"
                      autoComplete="off"
                      value={
                        !pending &&
                        hasStoredCredentials &&
                        !deletedKeys[field.key] &&
                        !editingKeys[field.key]
                          ? '**********'
                          : draft[field.key] || ''
                      }
                      onChange={e => updateField(field.key, e.target.value)}
                      placeholder={
                        !pending && hasStoredCredentials && !deletedKeys[field.key]
                          ? undefined
                          : field.placeholder
                      }
                      disabled={fieldsDisabled || readOnly || (!pending && !editingKeys[field.key])}
                    />
                    {!pending && !readOnly ? (
                      <div className="cu-credential-field__actions">
                        {editingKeys[field.key] ? (
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--sm"
                            onClick={() => void saveField(field.key)}
                            disabled={saving || !(draft[field.key] || '').trim()}
                            aria-label={`Save ${field.label}`}
                            title={`Save ${field.label}`}
                          >
                            <IconCheck width={16} height={16} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--sm"
                            onClick={() => editField(field.key)}
                            disabled={saving}
                            aria-label={`Edit ${field.label}`}
                            title={`Edit ${field.label}`}
                          >
                            <IconPencil width={16} height={16} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--danger-icon cu-btn--sm"
                          onClick={() => void deleteField(field.key)}
                          disabled={saving || !hasStoredCredentials || !!deletedKeys[field.key]}
                          aria-label={`Delete ${field.label}`}
                          title={`Delete ${field.label}`}
                        >
                          <IconTrash width={16} height={16} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {field.helpText ? <div className="cu-field__hint">{field.helpText}</div> : null}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ChannelCredentialsBadge({ status, saving }: { status: SaveStatus; saving: boolean }) {
  if (saving) {
    return (
      <span className="cu-channel-credentials__badge cu-channel-credentials__badge--loading">
        Saving…
      </span>
    )
  }
  if (status === 'saved') {
    return (
      <span className="cu-channel-credentials__badge cu-channel-credentials__badge--ok">Saved</span>
    )
  }
  if (status === 'error') {
    return (
      <span className="cu-channel-credentials__badge cu-channel-credentials__badge--missing">
        Error
      </span>
    )
  }
  return null
}
