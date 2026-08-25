'use client'

import { useState } from 'react'
import { apiSend } from '../lib/api'
import { createEmptyLlmKeyDraft, validateLlmSecretData } from '../lib/llm'
import { useConfirmDialog } from './ConfirmDialog'
import { LlmCredentialFields } from './LlmCredentialFields'
import { useToast } from './Toast'
import { IconX } from './icons'

export type LlmSecretUpdateModalProps = {
  secretName: string
  existingKeys: string[]
  onClose: () => void
  onChanged: () => Promise<void>
}

/**
 * The single update surface for an LLM Secret.
 *
 * Secret values are write-only: existingKeys contains names only, while the
 * draft contains only values the operator typed during this edit. Keeping the
 * write and retirement logic here means every entry point gets the same safe
 * merge semantics and the same provider editor.
 */
export function LlmSecretUpdateModal({
  secretName,
  existingKeys,
  onClose,
  onChanged,
}: LlmSecretUpdateModalProps) {
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>(() => createEmptyLlmKeyDraft())
  const [removedKeys, setRemovedKeys] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function closeModal() {
    if (!saving) onClose()
  }

  async function saveSecret() {
    const normalizedSecretName = secretName.trim()
    if (!normalizedSecretName) {
      setError('Secret name is required.')
      return
    }

    const stringData = Object.fromEntries(
      Object.entries(keyDraft)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value.length > 0)
    )
    // The server resolves a key present in both stringData and removeKeys as
    // retirement-wins. Keep the editor's write intent safe at the boundary.
    const removeKeys = removedKeys.filter(key => !(key in stringData))

    if (Object.keys(stringData).length === 0 && removeKeys.length === 0) {
      setError('Provide at least one API key.')
      return
    }

    const survivingKeys = new Set([
      ...existingKeys.filter(key => !removeKeys.includes(key)),
      ...Object.keys(stringData),
    ])
    if (survivingKeys.size === 0) {
      setError('Removing every key would leave the secret empty — delete the secret instead.')
      return
    }

    const slotErrors = validateLlmSecretData(stringData)
    if (slotErrors.length > 0) {
      setError(slotErrors[0])
      return
    }

    if (removeKeys.length > 0) {
      const confirmed = await confirm({
        title: 'Remove stored keys',
        message: `Permanently remove ${removeKeys.join(', ')} from secret ${normalizedSecretName}? Their values cannot be recovered.`,
        confirmLabel: 'Remove and save',
        tone: 'danger',
      })
      if (!confirmed) return
    }

    setSaving(true)
    setError('')
    try {
      await apiSend('PUT', '/api/v1/admin/secrets', {
        name: normalizedSecretName,
        merge: true,
        stringData,
        ...(removeKeys.length > 0 ? { removeKeys } : {}),
      })
      showToast(`Secret ${normalizedSecretName} updated.`, { tone: 'success' })
      await onChanged()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save secret')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--cu-overlay)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem',
        }}
        role="presentation"
        onClick={event => {
          if (event.target === event.currentTarget) closeModal()
        }}
      >
        <div
          className="cu-modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="llm-secret-title"
          onClick={event => event.stopPropagation()}
        >
          <div className="cu-modal-panel__head">
            <strong id="llm-secret-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
              Update LLM secret {secretName.trim()}
            </strong>
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--ghost"
              onClick={closeModal}
              disabled={saving}
              aria-label="Close"
            >
              <IconX width={18} height={18} />
            </button>
          </div>

          <div className="cu-form-stack" style={{ maxWidth: '100%' }}>
            <p className="cu-field__hint">
              Updates the listed keys and deletes the ones you remove here; every other key already
              stored in this secret is preserved.
            </p>
            <LlmCredentialFields
              draft={keyDraft}
              onChange={(dataKey, value) => setKeyDraft(prev => ({ ...prev, [dataKey]: value }))}
              existingKeys={existingKeys}
              // The editor reports on every change. Keep the parent state
              // identity-stable so it does not cause an unnecessary rerender.
              onRemovedKeysChange={next =>
                setRemovedKeys(prev => (prev.join('\n') === next.join('\n') ? prev : next))
              }
              disabled={saving}
              pickerInline
            />
          </div>

          {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

          <div className="cu-modal-panel__foot">
            <button
              type="button"
              className="cu-btn cu-btn--ghost cu-btn--sm"
              onClick={closeModal}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary"
              onClick={() => void saveSecret()}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Update secret'}
            </button>
          </div>
        </div>
      </div>
      {confirmDialog}
    </>
  )
}
