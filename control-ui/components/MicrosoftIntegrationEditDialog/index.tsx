'use client'

import { useEffect, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { Button, CheckboxField, Field, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { updateMicrosoftIdentityProviderConnection } from '@lib/api'
import type { MicrosoftIntegrationEditDialogProps } from './types'

export function MicrosoftIntegrationEditDialog({
  connection,
  onClose,
  onSaved,
}: MicrosoftIntegrationEditDialogProps) {
  const { confirm, confirmDialog } = useConfirmDialog()
  const [displayName, setDisplayName] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [allowMemberLogin, setAllowMemberLogin] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!connection) return
    setDisplayName(connection.displayName)
    setTenantId(connection.directoryTenantId)
    setClientId(connection.clientId)
    setClientSecret('')
    setAllowMemberLogin(connection.allowMemberLogin)
    setError('')
  }, [connection])

  if (!connection) return null

  async function handleLoginPolicyChange(enabled: boolean) {
    if (!enabled && allowMemberLogin) {
      const approved = await confirm({
        title: 'Turn off Microsoft sign-in?',
        message:
          'Members who do not have a password will need to use Forgot password before they can sign in again.',
        confirmLabel: 'Turn off Microsoft sign-in',
        cancelLabel: 'Keep Microsoft sign-in',
        tone: 'danger',
      })
      if (!approved) return
    }
    setAllowMemberLogin(enabled)
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const response = await updateMicrosoftIdentityProviderConnection(connection!.id, {
        displayName: displayName.trim(),
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret } : {}),
        clientSecretExpiresAt: clientSecret.trim() ? null : connection!.clientSecretExpiresAt,
        allowMemberLogin,
        returnUrl: `${window.location.origin}${CONTROL_ROUTES.settings.microsoftConnect()}`,
      })
      onSaved(response.connection)
      if (response.authorizeUrl) {
        window.location.assign(response.authorizeUrl)
        return
      }
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update integration')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="cu-modal-backdrop" role="presentation">
        <section
          className="cu-modal-panel cu-ms-integration-edit"
          role="dialog"
          aria-modal="true"
          aria-labelledby="microsoft-integration-edit-title"
        >
          <div className="cu-modal-panel__head">
            <h3 id="microsoft-integration-edit-title" className="cu-modal-panel__title">
              Edit Microsoft Teams integration
            </h3>
          </div>
          <div className="cu-modal-panel__body cu-form-stack">
            <Field label="Integration name" htmlFor="microsoft-edit-name" required>
              <TextInput
                id="microsoft-edit-name"
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
                disabled={saving}
              />
            </Field>
            <Field label="Directory (tenant) ID" htmlFor="microsoft-edit-tenant" required>
              <TextInput
                id="microsoft-edit-tenant"
                value={tenantId}
                onChange={event => setTenantId(event.target.value)}
                disabled={saving}
                monospace
              />
            </Field>
            <Field label="Application (client) ID" htmlFor="microsoft-edit-client" required>
              <TextInput
                id="microsoft-edit-client"
                value={clientId}
                onChange={event => setClientId(event.target.value)}
                disabled={saving}
                monospace
              />
            </Field>
            <Field
              label="Client secret value"
              htmlFor="microsoft-edit-secret"
              description="Leave this unchanged to keep the stored secret."
            >
              <TextInput
                id="microsoft-edit-secret"
                type="password"
                value={clientSecret}
                onChange={event => setClientSecret(event.target.value)}
                placeholder={connection.hasClientSecret ? '••••••••••••••••' : ''}
                disabled={saving}
                autoComplete="new-password"
              />
            </Field>
            <CheckboxField
              checked={allowMemberLogin}
              disabled={saving}
              onChange={event => void handleLoginPolicyChange(event.currentTarget.checked)}
              label="Allow members to sign in with Microsoft"
              description="Show Microsoft sign-in in eligible invitations, Profile UI, and Desktop App."
            />
            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
          </div>
          <div className="cu-modal-panel__foot">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={saving || !displayName.trim() || !tenantId.trim() || !clientId.trim()}
            >
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </section>
      </div>
      {confirmDialog}
    </>
  )
}
