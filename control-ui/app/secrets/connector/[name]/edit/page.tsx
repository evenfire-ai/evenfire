'use client'

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { BodyLoadingSkeleton } from '@components/BodyLoadingSkeleton'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconKey } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import { Button, Field, FormSection, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { type CredentialSchema, getRegistryCredentialSchema, updateMcpSecret } from '@lib/api'
import { reconcileCredentialRows } from '@lib/registryCredentialDraft'
import type { CredentialDraftRow } from '@lib/registryCredentialDraft.types'

function createDraftRow(
  id: string,
  secretKey = '',
  value = '',
  label?: string
): CredentialDraftRow {
  return { id, secretKey, value, label }
}

function EditConnectorSecretContent() {
  const router = useRouter()
  const params = useParams<{ name: string }>()
  const searchParams = useSearchParams()
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()

  const secretName = useMemo(() => {
    const raw = params?.name
    const value = Array.isArray(raw) ? raw[0] : raw
    try {
      return decodeURIComponent(value ?? '')
    } catch {
      return value ?? ''
    }
  }, [params])
  const registryEntry = (searchParams.get('registryEntry') ?? '').trim()
  const registryVersion = (searchParams.get('registryVersion') ?? '').trim()

  const [rows, setRows] = useState<CredentialDraftRow[]>(() => [
    createDraftRow('connector-secret-row-0'),
  ])
  const nextRowId = useRef(1)
  const [credentialSchema, setCredentialSchema] = useState<CredentialSchema | null>(null)
  const [credentialSchemaLoading, setCredentialSchemaLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!registryEntry || !registryVersion) {
      setCredentialSchema(null)
      setCredentialSchemaLoading(false)
      return
    }

    let cancelled = false
    setCredentialSchemaLoading(true)
    void getRegistryCredentialSchema(registryEntry, registryVersion)
      .then(schema => {
        if (cancelled) return
        setCredentialSchema(schema)
        if (schema.keys.length === 0) return
        setRows(current => reconcileCredentialRows(current, schema.keys))
      })
      .catch(() => {
        if (!cancelled) setCredentialSchema(null)
      })
      .finally(() => {
        if (!cancelled) setCredentialSchemaLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [registryEntry, registryVersion])

  const canSubmit =
    !saving && rows.some(row => row.secretKey.trim().length > 0 && row.value.trim().length > 0)

  function backToList() {
    router.push(CONTROL_ROUTES.secrets.connector)
  }

  function addDraftRow() {
    const nextId = nextRowId.current
    nextRowId.current += 1
    setRows(current => [...current, createDraftRow(`connector-secret-row-${nextId}`)])
  }

  function removeDraftRow(index: number) {
    setRows(current => current.filter((_, itemIndex) => itemIndex !== index))
  }

  function updateDraftRow(index: number, field: 'secretKey' | 'value', value: string) {
    setRows(current =>
      current.map((row, itemIndex) => (itemIndex === index ? { ...row, [field]: value } : row))
    )
  }

  async function save() {
    if (!secretName) {
      setError('Missing secret name in URL.')
      return
    }
    const data = Object.fromEntries(
      rows
        .map(row => [row.secretKey.trim(), row.value.trim()])
        .filter(([secretKey, value]) => secretKey.length > 0 && value.length > 0)
    )
    if (Object.keys(data).length === 0) {
      setError('Enter at least one key and a new value to update this secret.')
      return
    }

    const ok = await confirm({
      title: 'Update connector secret',
      message: `Rotate the values you entered in Secret ${secretName}? Connectors that reference it will restart to pick them up.`,
      confirmLabel: 'Update',
    })
    if (!ok) return

    setSaving(true)
    setError('')
    try {
      const result = await updateMcpSecret(secretName, data)
      const affected = Array.isArray(result.affectedConnectors) ? result.affectedConnectors : []
      showToast(
        affected.length > 0
          ? `Secret ${secretName} updated. Restarting connectors: ${affected.join(', ')}.`
          : `Secret ${secretName} updated.`,
        { tone: 'success' }
      )
      backToList()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update secret')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreatePageHeader
          icon={<IconKey />}
          title={`Edit connector secret${secretName ? `: ${secretName}` : ''}`}
          subtitle="Stored values are never shown. Type a new value to rotate a key — keys you leave blank keep their current value."
          backLabel="Back to secrets"
          onBack={backToList}
          backDisabled={saving}
        />

        <div className="cu-create-panel">
          <div className="cu-create-content">
            {credentialSchemaLoading ? (
              <p className="cu-muted">Loading connector credential fields…</p>
            ) : credentialSchema?.keys.length ? (
              <FormSection title="Secret values">
                <div className="cu-form-stack">
                  {rows.map((row, index) => (
                    <Field
                      key={row.id}
                      htmlFor={`${row.id}-value`}
                      label={row.label || row.secretKey}
                    >
                      <TextInput
                        id={`${row.id}-value`}
                        value={row.value}
                        onChange={event => updateDraftRow(index, 'value', event.target.value)}
                        placeholder={row.label || 'New credential value'}
                        type="password"
                        autoComplete="off"
                        disabled={saving}
                      />
                    </Field>
                  ))}
                </div>
              </FormSection>
            ) : (
              <FormSection title="Secret values">
                <div className="cu-form-grid">
                  {rows.map((row, index) => (
                    <div className="cu-form-inline" key={row.id}>
                      <TextInput
                        monospace
                        value={row.secretKey}
                        onChange={event => updateDraftRow(index, 'secretKey', event.target.value)}
                        placeholder="API_KEY"
                        disabled={saving}
                      />
                      <TextInput
                        monospace
                        value={row.value}
                        onChange={event => updateDraftRow(index, 'value', event.target.value)}
                        placeholder="secret value"
                        type="password"
                        autoComplete="off"
                        disabled={saving}
                      />
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        onClick={() => removeDraftRow(index)}
                        disabled={saving || rows.length === 1}
                        aria-label={`Remove key row ${index + 1}`}
                        title={`Remove key row ${index + 1}`}
                      >
                        <IconX width={16} height={16} />
                      </button>
                    </div>
                  ))}
                </div>

                <Button type="button" size="sm" onClick={addDraftRow} disabled={saving}>
                  Add key
                </Button>
              </FormSection>
            )}

            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
          </div>

          <div className="cu-create-actions">
            <Button type="button" variant="ghost" size="sm" onClick={backToList} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void save()}
              disabled={!canSubmit}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>

        {confirmDialog}
      </DashboardLayout>
    </AuthGate>
  )
}

export default function EditConnectorSecretPage() {
  return (
    <Suspense
      fallback={
        <BodyLoadingSkeleton
          backLabel="Back to secrets"
          icon={<IconKey />}
          primaryActionLabel="Save changes"
          sections={2}
          subtitle="Load the connector credential fields before editing stored values."
          title="Edit connector secret"
        />
      }
    >
      <EditConnectorSecretContent />
    </Suspense>
  )
}
