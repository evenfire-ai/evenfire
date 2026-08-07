'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { FormSectionsSkeleton } from '@components/BodyLoadingSkeleton'
import { DetailPageShell } from '@components/DetailPageShell'
import { EgressEditor } from '@components/EgressEditor'
import { IconCable } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { UpdateConnectorCredentials } from '@components/UpdateConnectorCredentials'
import {
  CONNECTOR_EDIT_DEFAULT_TAB,
  CONNECTOR_EDIT_TABS,
  CONNECTOR_EDIT_TAB_LABELS,
  type ConnectorEditTab,
} from '@constants/connectorEdit'
import { CONTROL_ROUTES } from '@constants/routes'
import { getMcpServer, updateMcpServer } from '@lib/api'
import type { EgressBinding, EnvSecret, EnvSecretKeyMapping, McpServerResource } from '@lib/api'
import type { EgressEditorStatus } from '@lib/egressModel'

/**
 * Narrows `server.spec.envSecret` (typed as `unknown` on the generic
 * `AnyRecord` spec) into the shape UpdateConnectorCredentials needs. A
 * malformed or partial envSecret (missing name, keys not an array, or no
 * usable key mappings) is treated the same as "no envSecret" — there is
 * nothing safely rotatable through this form either way.
 */
function resolveEnvSecret(spec: Record<string, unknown> | undefined): EnvSecret | undefined {
  const raw = spec?.envSecret
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as { name?: unknown; keys?: unknown }
  if (typeof candidate.name !== 'string' || !Array.isArray(candidate.keys)) return undefined
  const keys = candidate.keys.filter(
    (k): k is EnvSecretKeyMapping =>
      Boolean(k) &&
      typeof (k as EnvSecretKeyMapping).secretKey === 'string' &&
      typeof (k as EnvSecretKeyMapping).envVar === 'string'
  )
  if (keys.length === 0) return undefined
  return { name: candidate.name, keys }
}

function parseConnectorEditTab(value: string | string[] | undefined): ConnectorEditTab {
  const candidate = Array.isArray(value) ? value[0] : value
  return CONNECTOR_EDIT_TABS.find(tab => tab === candidate) ?? CONNECTOR_EDIT_DEFAULT_TAB
}

export default function EditMcpServerPage() {
  const router = useRouter()
  const params = useParams<{ name: string; tab?: string | string[] }>()
  const name = decodeURIComponent(params?.name ?? '')
  const { showToast } = useToast()

  const activeTab = parseConnectorEditTab(params?.tab)

  const [server, setServer] = useState<McpServerResource | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [egressBindings, setEgressBindings] = useState<EgressBinding[] | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)

  function backToList() {
    router.push(CONTROL_ROUTES.connectors.root)
  }

  function selectTab(next: ConnectorEditTab) {
    if (next === CONNECTOR_EDIT_DEFAULT_TAB) {
      router.replace(CONTROL_ROUTES.connectors.edit(name))
    } else {
      router.replace(CONTROL_ROUTES.connectors.editTab(name, next))
    }
  }

  const handleEgressChange = useCallback(
    (nextBindings: EgressBinding[] | undefined, nextStatus: EgressEditorStatus) => {
      setEgressBindings(nextBindings)
      setEgressStatus(nextStatus)
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const result = await getMcpServer(name)
        if (cancelled) return
        setServer(result)
        setEgressBindings((result.spec?.egressBindings as EgressBinding[] | undefined) ?? undefined)
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load connector')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (name) void load()
    return () => {
      cancelled = true
    }
  }, [name])

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!server?.spec || saving || egressStatus?.errors.length) return
    setSaving(true)
    setSaveError('')
    try {
      const nextSpec = { ...(server.spec as Record<string, unknown>) }
      if (egressBindings && egressBindings.length > 0) {
        nextSpec.egressBindings = egressBindings
      } else {
        delete nextSpec.egressBindings
      }
      await updateMcpServer(name, { spec: nextSpec })
      showToast(`Connector ${name} updated.`, { tone: 'success' })
      backToList()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to update connector')
    } finally {
      setSaving(false)
    }
  }

  const envSecret = server?.spec
    ? resolveEnvSecret(server.spec as Record<string, unknown>)
    : undefined

  return (
    <AuthGate>
      <DetailPageShell<ConnectorEditTab>
        activeTab={activeTab}
        backLabel="Back to connectors"
        icon={<IconCable />}
        onBack={backToList}
        onTabChange={selectTab}
        subtitle="Update external egress and rotate credentials for this connector."
        tabAriaLabel="Connector edit sections"
        tabClassName="cu-tabs--compact"
        tabs={CONNECTOR_EDIT_TABS.map(tab => ({
          value: tab,
          label: CONNECTOR_EDIT_TAB_LABELS[tab],
          href:
            tab === CONNECTOR_EDIT_DEFAULT_TAB
              ? CONTROL_ROUTES.connectors.edit(name)
              : CONTROL_ROUTES.connectors.editTab(name, tab),
        }))}
        title={`Edit Connector: ${name}`}
        error={loadError || undefined}
      >
        {loading ? (
          activeTab === 'credentials' ? (
            <div
              role="status"
              aria-busy="true"
              aria-label="Loading connector credentials"
              className="cu-body-loading-skeleton"
            >
              <section className="cu-body-loading-skeleton__section">
                <span className="cu-skeleton cu-body-loading-skeleton__heading" />
                <span className="cu-skeleton cu-body-loading-skeleton__line" />
                <div className="cu-body-loading-skeleton__fields">
                  <span className="cu-skeleton cu-body-loading-skeleton__field" />
                  <span className="cu-skeleton cu-body-loading-skeleton__field" />
                </div>
              </section>
            </div>
          ) : (
            <FormSectionsSkeleton label="Connector" primaryActionLabel="Save egress" sections={2} />
          )
        ) : server ? (
          activeTab === 'credentials' ? (
            <UpdateConnectorCredentials serverName={name} envSecret={envSecret} />
          ) : (
            <form className="cu-connector-edit-content" onSubmit={handleSave}>
              <div className="cu-connector-edit-meta">
                <div>
                  <strong>Image:</strong>{' '}
                  <code>{typeof server.spec?.image === 'string' ? server.spec.image : '-'}</code>
                </div>
                <div>
                  <strong>Context:</strong>{' '}
                  <code>
                    {typeof server.spec?.contextRef === 'string' ? server.spec.contextRef : '-'}
                  </code>
                </div>
              </div>

              <EgressEditor
                allowCidr
                key={`${name}-${JSON.stringify(server.spec?.egressBindings ?? [])}`}
                initialBindings={server.spec?.egressBindings as EgressBinding[] | undefined}
                onChange={handleEgressChange}
                title="External Egress"
                description="Adjust only the external egress contract. Other connector settings are preserved."
              />

              {saveError ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {saveError}
                </div>
              ) : null}

              <div className="cu-create-actions">
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost"
                  disabled={saving}
                  onClick={backToList}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cu-btn cu-btn--primary"
                  disabled={saving || Boolean(egressStatus?.errors.length)}
                >
                  {saving ? 'Saving...' : 'Save egress'}
                </button>
              </div>
            </form>
          )
        ) : null}
      </DetailPageShell>
    </AuthGate>
  )
}
