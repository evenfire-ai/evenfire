'use client'

import React, { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmModelForm } from '@components/LlmModelForm'
import { IconModels } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import { type CreateLlmModelInput, createLlmModel, isLlmModelConfigMapDeferred } from '@lib/api'

function CreateLlmModelContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const prefill = {
    provider: searchParams.get('provider') ?? undefined,
    model: searchParams.get('model') ?? undefined,
  }

  function backToList() {
    router.push(CONTROL_ROUTES.llmModels.root)
  }

  async function handleSubmit(input: CreateLlmModelInput) {
    setSaving(true)
    setError('')
    try {
      await createLlmModel(input)
      showToast(`${input.provider}/${input.model} added to the allowlist.`, { tone: 'success' })
      backToList()
    } catch (e) {
      // The row was created; only the runtime ConfigMap write is delayed.
      if (isLlmModelConfigMapDeferred(e)) {
        showToast(
          `${input.provider}/${input.model} added. Propagation to the cluster is delayed and will reconcile shortly.`,
          { tone: 'info' }
        )
        backToList()
        return
      }
      setError(e instanceof Error ? e.message : 'Failed to add model')
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
              title="Add allowed model"
              subtitle="Allow a provider/model so agents and runtime can select it."
              backLabel="Back to models"
              onBack={backToList}
              backDisabled={saving}
            />
          }
        >
          <LlmModelForm
            mode="create"
            prefill={prefill}
            saving={saving}
            error={error}
            onSubmit={handleSubmit}
            onCancel={backToList}
          />
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}

export default function CreateLlmModelPage() {
  return (
    <Suspense fallback={null}>
      <CreateLlmModelContent />
    </Suspense>
  )
}
