'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { EgressEditor } from '@components/EgressEditor'
import { IconStore } from '@components/Sidebar/icons'
import { Button, Field, TextAreaInput, TextInput } from '@components/ui'
import { getRegistryEntryVersion, updateRegistryEntry } from '@lib/api'
import type { RegistryEntry } from '@lib/api'
import { egressStatusToRegistrySummary, registrySummaryToEgressBindings } from '@lib/egressModel'
import type { EgressEditorStatus, EgressSummary } from '@lib/egressModel'

function tagsToInput(tags: string[] | undefined): string {
  return tags?.join(', ') ?? ''
}

function inputToTags(value: string): string[] {
  return value
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0)
}

export default function EditRegistryEntryPage() {
  const router = useRouter()
  const params = useParams<{ name: string; version: string }>()
  const name = decodeURIComponent(params?.name ?? '')
  const version = decodeURIComponent(params?.version ?? '')

  const [entry, setEntry] = useState<RegistryEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [egressSummary, setEgressSummary] = useState<EgressSummary | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const match = await getRegistryEntryVersion(name, version)
        if (cancelled) return
        setEntry(match)
        setDescription(match.description ?? '')
        setTagsInput(tagsToInput(match.tags))
        setEgressSummary(match.mcp_server_meta?.egressSummary)
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load Marketplace entry')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (name && version) void load()
    return () => {
      cancelled = true
    }
  }, [name, version])

  function backToCatalog() {
    router.push('/registry')
  }

  const handleEgressChange = useCallback((_bindings: unknown, status: EgressEditorStatus) => {
    setEgressStatus(status)
    setEgressSummary(egressStatusToRegistrySummary(status))
  }, [])

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (saving || !entry) return
    if (egressStatus?.errors.length) return
    setSaving(true)
    setSaveError('')
    try {
      const trimmedDescription = description.trim()
      const nextTags = inputToTags(tagsInput)
      const fields: {
        description?: string
        tags?: string[]
        mcpServer?: { egressSummary?: EgressSummary | null }
      } = {}
      if (trimmedDescription !== (entry.description ?? '')) {
        fields.description = trimmedDescription
      }
      const currentTags = entry.tags ?? []
      const tagsChanged =
        nextTags.length !== currentTags.length || nextTags.some((t, i) => t !== currentTags[i])
      if (tagsChanged) {
        fields.tags = nextTags
      }
      if (entry.entry_type === 'mcp-server' && entry.server_mode === 'local') {
        const previousSummary = entry.mcp_server_meta?.egressSummary ?? null
        const nextSummary = egressSummary ?? null
        if (JSON.stringify(previousSummary) !== JSON.stringify(nextSummary)) {
          fields.mcpServer = { egressSummary: nextSummary }
        }
      }
      if (Object.keys(fields).length === 0) {
        // Nothing to save — just go back so the user isn't blocked on a noop.
        backToCatalog()
        return
      }
      await updateRegistryEntry(name, version, fields)
      backToCatalog()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes')
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
              icon={<IconStore />}
              title="Edit Marketplace metadata"
              subtitle={
                entry
                  ? `Update fields shown to consumers for ${entry.name} v${entry.version}.`
                  : 'Update fields shown to consumers in the Marketplace.'
              }
              backLabel="Back to Marketplace"
              onBack={backToCatalog}
            />
          }
        >
          {loading ? (
            <div className="cu-create-content cu-registry-edit-form">
              <div className="cu-muted">Loading entry…</div>
            </div>
          ) : loadError ? (
            <div className="cu-create-content cu-registry-edit-form">
              <div className="cu-banner cu-banner--error">{loadError}</div>
            </div>
          ) : entry ? (
            <form className="cu-create-content cu-registry-edit-form" onSubmit={handleSave}>
              <Field
                description="Shown in the Marketplace row; keep it brief."
                htmlFor="reg-edit-description"
                label="Description"
              >
                <TextAreaInput
                  id="reg-edit-description"
                  rows={4}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  disabled={saving}
                />
              </Field>

              <Field
                description="Comma-separated. Used by the Marketplace search and tag chips."
                htmlFor="reg-edit-tags"
                label="Tags"
              >
                <TextInput
                  id="reg-edit-tags"
                  type="text"
                  value={tagsInput}
                  onChange={e => setTagsInput(e.target.value)}
                  disabled={saving}
                  placeholder="comma, separated, tags"
                />
              </Field>

              {entry.entry_type === 'mcp-server' && entry.server_mode === 'local' ? (
                <EgressEditor
                  key={`${entry.name}-${entry.version}-${JSON.stringify(entry.mcp_server_meta?.egressSummary ?? null)}`}
                  description="Update the Marketplace metadata that Control API translates into connector egress bindings during install."
                  initialBindings={registrySummaryToEgressBindings(
                    entry.mcp_server_meta?.egressSummary
                  )}
                  onChange={handleEgressChange}
                  title="Marketplace Egress Metadata"
                />
              ) : entry.entry_type === 'mcp-server' && entry.server_mode === 'remote' ? (
                <div className="cu-banner cu-banner--info" role="status">
                  Remote connector egress is derived from the selected endpoint and routed through
                  the nginx egress proxy. Edit the endpoint metadata to change its target.
                </div>
              ) : null}

              {saveError ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {saveError}
                </div>
              ) : null}

              <div className="cu-create-actions">
                <Button type="button" variant="ghost" onClick={backToCatalog} disabled={saving}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={saving || Boolean(egressStatus?.errors.length)}
                >
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </form>
          ) : null}
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
