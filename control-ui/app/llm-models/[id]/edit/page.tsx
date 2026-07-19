'use client'

import React, { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmModelForm } from '@components/LlmModelForm'
import { IconModels } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type CreateLlmModelInput,
  type LlmAllowedModel,
  getLlmModel,
  isLlmModelConfigMapDeferred,
  updateLlmModel,
} from '@lib/api'

export default function EditLlmModelPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = decodeURIComponent(params?.id ?? '')
  const { showToast } = useToast()

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
    setSaving(true)
    setSaveError('')
    try {
      await updateLlmModel(id, input)
      showToast(`${input.provider}/${input.model} updated.`, { tone: 'success' })
      backToList()
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
      setSaveError(e instanceof Error ? e.message : 'Failed to update model')
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
            <div className="cu-px-form">
              <div className="cu-create-content">Loading model...</div>
            </div>
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
      </DashboardLayout>
    </AuthGate>
  )
}
