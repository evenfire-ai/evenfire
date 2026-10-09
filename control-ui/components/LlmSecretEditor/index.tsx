'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, FormSection } from '@components/ui'
import { apiSend } from '@lib/api'
import { createEmptyLlmKeyDraft, validateLlmSecretData } from '@lib/llm'
import { useConfirmDialog } from '../ConfirmDialog'
import { LlmCredentialFields } from '../LlmCredentialFields'
import { useToast } from '../Toast'
import type { LlmSecretEditorProps } from './types'

export type { LlmSecretEditorProps } from './types'

/**
 * The single update surface for an LLM Secret.
 *
 * Secret values are write-only: existingKeys contains names only, while the
 * draft contains only values the operator typed during this edit. Keeping the
 * write and retirement logic here means every entry point gets the same safe
 * merge semantics and the same provider editor.
 */
export function LlmSecretEditor({
  secretName,
  existingKeys,
  protectedCredentialSlots = [],
  onClose,
}: LlmSecretEditorProps) {
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>(() => createEmptyLlmKeyDraft())
  const [removedKeys, setRemovedKeys] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function cancel() {
    if (!saving) onClose()
  }

  // Same contract as the reference create forms (LlmPriceForm/LlmModelForm):
  // the primary action is a true submit, pending disables the entry points.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    void saveSecret()
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

    // A fallback credentialSlot is a live reference into this Secret. Refuse
    // the retirement before the empty-secret check and confirmation dialog so
    // the operator gets the actionable reason even when this is the Secret's
    // last stored key. Re-adding the key above intentionally removes it from
    // removeKeys, so replacing a protected slot remains allowed.
    const protectedSlotSet = new Set(protectedCredentialSlots)
    const blockedRemovals = removeKeys.filter(key => protectedSlotSet.has(key))
    if (blockedRemovals.length > 0) {
      const quotedSlots = blockedRemovals.map(key => `"${key}"`).join(', ')
      setError(
        `Cannot remove ${quotedSlots}: an active fallback still references ${blockedRemovals.length === 1 ? 'this credential slot' : 'these credential slots'}. Update the fallback configuration first.`
      )
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
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save secret')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <form className="cu-create-content cu-px-form" onSubmit={handleSubmit}>
        <FormSection
          title="Stored credentials"
          description="Stored values are never returned by the API — keep a stored key as is or replace it. Removing an additional credential slot deletes that key on save; slots marked fallback-locked are referenced by an active fallback policy and cannot be removed here. Every other key already stored in this secret is preserved."
        >
          <LlmCredentialFields
            draft={keyDraft}
            onChange={(dataKey, value) => setKeyDraft(prev => ({ ...prev, [dataKey]: value }))}
            existingKeys={existingKeys}
            protectedKeys={protectedCredentialSlots}
            // The editor reports on every change. Keep the parent state
            // identity-stable so it does not cause an unnecessary rerender.
            onRemovedKeysChange={next =>
              setRemovedKeys(prev => (prev.join('\n') === next.join('\n') ? prev : next))
            }
            disabled={saving}
          />
        </FormSection>

        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="cu-create-actions">
          <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Update secret'}
          </Button>
        </div>
      </form>
      {confirmDialog}
    </>
  )
}
