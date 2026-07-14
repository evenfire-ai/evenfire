'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { EgressEditor } from '@components/EgressEditor'
import { IconCable } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { getMcpServer, updateMcpServer } from '@lib/api'
import type { EgressBinding, McpServerResource } from '@lib/api'
import type { EgressEditorStatus } from '@lib/egressModel'

export default function EditMcpServerPage() {
  const router = useRouter()
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(params?.name ?? '')
  const { showToast } = useToast()

  const [server, setServer] = useState<McpServerResource | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [egressBindings, setEgressBindings] = useState<EgressBinding[] | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)

  function backToList() {
    router.push('/mcp-servers')
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

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconCable />}
              title={`Edit Connector: ${name}`}
              subtitle="Update explicit external egress for this connector."
              backLabel="Back to connectors"
              onBack={backToList}
            />
          }
        >
          {loading ? (
            <div className="cu-connector-edit-form">
              <div className="cu-create-content">Loading connector...</div>
            </div>
          ) : loadError ? (
            <div className="cu-connector-edit-form">
              <div className="cu-banner cu-banner--error" role="alert">
                {loadError}
              </div>
            </div>
          ) : server ? (
            <form className="cu-connector-edit-form" onSubmit={handleSave}>
              <div className="cu-create-content cu-connector-edit-content">
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
              </div>
            </form>
          ) : null}
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
