'use client'

import React, { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { FormSectionsSkeleton } from '@components/BodyLoadingSkeleton'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmModelForm } from '@components/LlmModelForm'
import { ModelReferences } from '@components/ModelReferences'
import { IconModels } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type CreateLlmModelInput,
  type LlmAllowedModel,
  getLlmModel,
  getModelInUseImpact,
  isLlmModelConfigMapDeferred,
  updateLlmModel,
} from '@lib/api'

export default function EditLlmModelPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = decodeURIComponent(params?.id ?? '')
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

  const [model, setModel] = useState<LlmAllowedModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  function backToList() {
    router.push(CONTROL_ROUTES.llmModels.root)
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const result = await getLlmModel(id)
        if (cancelled) return
        setModel(result)
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load model')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (id) void load()
    return () => {
      cancelled = true
    }
  }, [id])

  async function handleSubmit(input: CreateLlmModelInput) {
    await saveWithImpactGate(input, false)
  }

  // Disabling a referenced model (enabled→false) is gated by control-api: without
  // `?force` it answers 409 `model_in_use` with the impact. Show it and let the
  // operator confirm a forced retry — never force automatically (spec Fase 3/5).
  async function saveWithImpactGate(input: CreateLlmModelInput, force: boolean) {
    setSaving(true)
    setSaveError('')
    let impact: ReturnType<typeof getModelInUseImpact> = null
    try {
      await updateLlmModel(id, input, force ? { force: true } : {})
      showToast(`${input.provider}/${input.model} updated.`, { tone: 'success' })
      backToList()
      return
    } catch (e) {
      // The row was updated; only the runtime ConfigMap write is delayed.
      if (isLlmModelConfigMapDeferred(e)) {
        showToast(
          `${input.provider}/${input.model} updated. Propagation to the cluster is delayed and will reconcile shortly.`,
          { tone: 'info' }
        )
        backToList()
        return
      }
      impact = getModelInUseImpact(e)
      if (!impact) {
        setSaveError(e instanceof Error ? e.message : 'Failed to update model')
        return
      }
    } finally {
      setSaving(false)
    }

    const forceDisable = await confirm({
      title: 'Model still in use',
      message: `${input.provider}/${input.model} is still referenced. Disabling it leaves these references pointing at a disabled model:`,
      details: (
        <ModelReferences
          hostsAffected={impact.hostsAffected}
          grantsAffected={impact.grantsAffected}
        />
      ),
      confirmLabel: 'Disable anyway',
      tone: 'danger',
    })
    if (forceDisable) await saveWithImpactGate(input, true)
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconModels />}
              title="Edit allowed model"
              subtitle="Update the allowlist entry for this provider/model."
              backLabel="Back to models"
              onBack={backToList}
              backDisabled={saving}
            />
          }
        >
          {loading ? (
            <FormSectionsSkeleton
              className="cu-px-form"
              label="Allowed model"
              primaryActionLabel="Save model"
              sections={2}
            />
          ) : loadError ? (
            <div className="cu-px-form">
              <div className="cu-banner cu-banner--error" role="alert">
                {loadError}
              </div>
            </div>
          ) : model ? (
            <LlmModelForm
              mode="edit"
              initial={model}
              saving={saving}
              error={saveError}
              onSubmit={handleSubmit}
              onCancel={backToList}
            />
          ) : null}
        </CreateFlowPanel>
        {confirmDialog}
      </DashboardLayout>
    </AuthGate>
  )
}
