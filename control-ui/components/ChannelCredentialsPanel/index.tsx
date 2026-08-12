'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck, IconPencil, IconTrash } from '@components/icons'
import { cn } from '@lib/cn'
import { apiSend } from '../../lib/api'
import { RetryBanner } from '../PublisherView/RetryBanner'
import { useToast } from '../Toast'
import { CHANNEL_CREDENTIAL_FIELDS } from './constants'
import type { ChannelCredentialsPanelProps, CredentialDraft } from './types'

function emptyDraft(): CredentialDraft {
  return {}
}

type SaveStatus = 'idle' | 'saved' | 'error'

/** Stand-in for a stored value. The API never returns values, only key names. */
const MASKED_VALUE = '**********'
/** Shown while `storedKeys` is unknown. Distinct from the per-field placeholder
 *  so a page load cannot flash "nothing stored" before the answer arrives. */
const PENDING_PLACEHOLDER = 'Checking stored credentials…'
/** Shown per field once the stored-key read has FAILED. The panel knows nothing
 *  about this key, and a blank field with its normal placeholder would read as
 *  "nothing stored", which is the lie this panel exists to stop. */
const UNKNOWN_PLACEHOLDER = 'Stored value unknown'
/** Banner copy for a failed stored-key read. Rotation is a blind PUT that does
 *  not need to know the current state, so it stays available; deleting a key
 *  the panel cannot see does not. */
const STORED_KEYS_ERROR =
  'Could not check which credentials are stored. You can still rotate a value; deleting one needs a successful read.'
/**
 * Slack offers four secrets and this platform uses two of them. The "app is
 * ready" dialog puts the App-Level Token next to the bot token, and the Signing
 * Secret is filed next to a Client Secret on a page the dialog never links to,
 * so both wrong values are the easy ones to grab.
 */
const SLACK_CREDENTIAL_NOTE =
  'You do not need the App-Level Token (xapp-) or the Client Secret. Slack hands out the xapp- token beside the xoxb- one, and the Signing Secret is not in that dialog at all: find it on Basic Information, under App Credentials.'

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
 *
 * Stored state is per key (`storedKeys`), never per channel: a field renders
 * masked only when the Secret holds that field's own key. The panel used to
 * take one boolean for the whole channel, so a Telegram-only Secret made every
 * Slack field look populated.
 *
 * That state has three cases, not two: the read is in flight (`storedKeys`
 * undefined, controls closed because the answer landing would discard whatever
 * was typed), the read answered (`storedKeys` set), or the read FAILED
 * (`storedKeysError`). The failed case says so and keeps rotation open —
 * a PUT overwrites whatever is there and needs no knowledge of it — while
 * Delete stays closed, because a key the panel cannot see is not safe to drop.
 */
export function ChannelCredentialsPanel({
  ccName,
  pending,
  onPendingChange,
  storedKeys,
  storedKeysError,
  onRetryStoredKeys,
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
  // Keys this panel stored itself since the parent last read the Secret. Without
  // it a freshly saved credential would render empty until the page reloaded,
  // which is the same lie in the other direction.
  const [savedKeys, setSavedKeys] = useState<Partial<Record<keyof CredentialDraft, boolean>>>({})

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

  // Stable signature of the stored key list. `null` means "not known yet".
  // Effects key on this string, never on the array: parents hand over a fresh
  // array on most renders, and keying on identity would reset the panel
  // mid-typing and silently discard what the operator entered.
  const storedSignature = storedKeys ? [...storedKeys].sort().join('|') : null
  const storedKeySet = useMemo(
    () => new Set<string>(storedKeys ?? []),
    // storedSignature stands in for storedKeys — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storedSignature]
  )
  // The read is over and its answer is unusable. Create flows have no Secret to
  // read, so they never reach this state either.
  const storedKeysReadFailed = !pending && Boolean(storedKeysError)
  // Nothing is known about the Secret YET, i.e. the read is still in flight.
  // Create flows have no Secret to read, so they are never pending. A failed
  // read is not pending: leaving it here disabled the whole panel forever,
  // under a placeholder describing a request that had already finished.
  const keysPending = !pending && storedSignature === null && !storedKeysReadFailed

  // Reset local state when the target CC changes so values typed for CC A
  // are not saved against CC B if the parent swaps `ccName` without unmounting.
  // Also on a re-read of the Secret: the stored keys are the source of truth the
  // fields render, so local edit/delete marks made against the previous answer
  // no longer describe anything.
  useEffect(() => {
    setDraft(emptyDraft())
    setError('')
    setStatus('idle')
    setEditingKeys({})
    setDeletedKeys({})
    setSavedKeys({})
    requestId.current += 1
  }, [ccName, storedSignature])

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
      setSavedKeys(prev => ({ ...prev, [key]: true }))
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
      setSavedKeys(prev => ({ ...prev, [key]: false }))
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

  /** True when the Secret holds this exact key, as far as the panel knows.
   *  A key deleted here is gone even if the parent's list still lists it; a key
   *  saved here exists even if the parent's list predates the save. */
  function isKeyStored(key: keyof CredentialDraft): boolean {
    if (pending || keysPending) return false
    if (deletedKeys[key]) return false
    if (savedKeys[key]) return true
    return storedKeySet.has(key)
  }

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
            in the <code>channels</code> namespace. Values are write-only — a key the Secret holds
            renders masked, every other field renders blank, and stored values are never returned.
            The Secret is created on first save and follows the CC if you change{' '}
            <code>hostRef</code>.
          </p>
        </>
      )}

      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

      {storedKeysReadFailed ? (
        <div role="alert">
          {onRetryStoredKeys ? (
            <RetryBanner message={STORED_KEYS_ERROR} onRetry={onRetryStoredKeys} />
          ) : (
            <p className="cu-banner cu-banner--warn">{STORED_KEYS_ERROR}</p>
          )}
          <p className="cu-field__hint cu-channel-credentials__note">{storedKeysError}</p>
        </div>
      ) : null}

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
              {fields.map(field => {
                const stored = isKeyStored(field.key)
                return (
                  <div key={field.key} className="cu-field cu-field--compact">
                    <label htmlFor={`channel-cred-${field.key}`}>{field.label}</label>
                    <div className="cu-credential-field">
                      <input
                        id={`channel-cred-${field.key}`}
                        type="password"
                        autoComplete="off"
                        value={
                          stored && !editingKeys[field.key] ? MASKED_VALUE : draft[field.key] || ''
                        }
                        onChange={e => updateField(field.key, e.target.value)}
                        placeholder={
                          keysPending
                            ? PENDING_PLACEHOLDER
                            : stored
                              ? undefined
                              : storedKeysReadFailed
                                ? UNKNOWN_PLACEHOLDER
                                : field.placeholder
                        }
                        aria-busy={keysPending || undefined}
                        disabled={
                          fieldsDisabled ||
                          readOnly ||
                          keysPending ||
                          (!pending && !editingKeys[field.key])
                        }
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
                              disabled={saving || keysPending}
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
                            disabled={saving || keysPending || !stored}
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
                )
              })}
              {fields.some(field => field.channelType === 'slack') ? (
                <p className="cu-field__hint cu-channel-credentials__note">
                  {SLACK_CREDENTIAL_NOTE}
                </p>
              ) : null}
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
