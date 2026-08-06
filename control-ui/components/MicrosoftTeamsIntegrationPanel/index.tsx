'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { MicrosoftIntegrationEditDialog } from '@components/MicrosoftIntegrationEditDialog'
import { useSettingsData } from '@components/SettingsDataContext'
import { SettingsIntegrationsNav } from '@components/SettingsIntegrationsNav'
import { useToast } from '@components/Toast'
import { IconPencil } from '@components/icons'
import { Button } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { disconnectIdentityProviderConnection } from '@lib/api'
import { identityProviderConnectionLabel } from '@lib/identityProviders'
import type { IdentityProviderConnection } from '@lib/identityProviders.types'

export function MicrosoftTeamsIntegrationPanel() {
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const {
    connections,
    connectionsLoading: loading,
    integrationsError,
    refreshConnections,
    removeConnection,
    replaceConnection,
  } = useSettingsData()
  const [disconnectingId, setDisconnectingId] = useState('')
  const [actionError, setActionError] = useState('')
  const [editingConnection, setEditingConnection] = useState<IdentityProviderConnection | null>(
    null
  )
  const error = actionError || integrationsError

  const visibleConnections = useMemo(
    () => connections.filter(connection => connection.status !== 'disconnected'),
    [connections]
  )
  const connectedCount = useMemo(
    () => connections.filter(connection => connection.status === 'connected').length,
    [connections]
  )

  async function handleDisconnect(connection: IdentityProviderConnection) {
    const approved = await confirm({
      title: 'Disconnect Microsoft Teams?',
      message:
        'Microsoft sign-in and directory imports for this organization will stop immediately. Existing members can use password recovery.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    })
    if (!approved) return

    setDisconnectingId(connection.id)
    setActionError('')
    try {
      await disconnectIdentityProviderConnection(connection.id)
      removeConnection(connection.id)
      await refreshConnections()
      showToast(`${identityProviderConnectionLabel(connection)} disconnected.`, {
        tone: 'success',
      })
    } catch (disconnectError) {
      setActionError(
        disconnectError instanceof Error ? disconnectError.message : 'Disconnect failed'
      )
    } finally {
      setDisconnectingId('')
    }
  }

  return (
    <div className="cu-settings-integrations">
      <SettingsIntegrationsNav activeSection="microsoft" />

      <section className="cu-settings-section">
        <div className="cu-settings-section__header">
          <div className="cu-settings-section__heading">
            <span className="cu-settings-section__title">Microsoft Teams</span>
            <span className="cu-settings-row__hint">
              Import existing Microsoft Teams and users so you do not need to recreate your
              organization manually. Members can also use their existing Microsoft work account as a
              secure sign-in method for Evenfire.
            </span>
          </div>
          {!loading ? (
            <Link
              className="cu-btn cu-btn--primary cu-btn--sm"
              href={CONTROL_ROUTES.settings.microsoftConnect({ fresh: 1 })}
            >
              {connectedCount > 0 ? 'Add another' : 'Integrate with Microsoft Teams'}
            </Link>
          ) : null}
        </div>

        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
        {loading ? <div className="cu-muted">Loading Microsoft Teams integrations...</div> : null}

        {!loading && visibleConnections.length === 0 ? (
          <div className="cu-settings-integration-empty">
            <span>No Microsoft Teams organizations are connected.</span>
          </div>
        ) : null}

        {!loading && visibleConnections.length > 0 ? (
          <div className="cu-settings-list">
            {visibleConnections.map(connection => (
              <div className="cu-settings-row cu-settings-integration-row" key={connection.id}>
                <div className="cu-settings-row__main">
                  <span className="cu-settings-row__label">
                    {identityProviderConnectionLabel(connection)}
                  </span>
                  <span className="cu-settings-row__value">
                    {connection.status === 'connected'
                      ? connection.validForLogin
                        ? 'Teams connected · Microsoft sign-in enabled'
                        : 'Teams connected'
                      : connection.status}
                  </span>
                  <span className="cu-settings-row__hint">
                    Tenant ID: {connection.directoryTenantId}
                  </span>
                  <span className="cu-settings-row__hint">Client ID: {connection.clientId}</span>
                  {connection.lastError ? (
                    <span className="cu-settings-row__hint cu-text-danger">
                      {connection.lastError}
                    </span>
                  ) : null}
                </div>
                <div className="cu-settings-row__actions">
                  <button
                    type="button"
                    className="cu-btn cu-btn--icon cu-btn--toolbar"
                    aria-label={`Edit ${identityProviderConnectionLabel(connection)}`}
                    title="Edit integration"
                    onClick={() => setEditingConnection(connection)}
                  >
                    <IconPencil width={16} height={16} />
                  </button>
                  {connection.status === 'connected' ? (
                    <Link
                      className="cu-btn cu-btn--secondary cu-btn--sm"
                      href={CONTROL_ROUTES.settings.microsoftConnect({
                        connectionId: connection.id,
                      })}
                    >
                      Import users
                    </Link>
                  ) : null}
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={Boolean(disconnectingId)}
                    onClick={() => void handleDisconnect(connection)}
                  >
                    {disconnectingId === connection.id ? 'Disconnecting...' : 'Disconnect'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <MicrosoftIntegrationEditDialog
        connection={editingConnection}
        onClose={() => setEditingConnection(null)}
        onSaved={connection => {
          replaceConnection(connection)
          showToast('Microsoft Teams integration updated.', { tone: 'success' })
        }}
      />
      {confirmDialog}
    </div>
  )
}
