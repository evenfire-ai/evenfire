'use client'

import React, { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { BodyLoadingSkeleton } from '@components/BodyLoadingSkeleton'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmPriceForm } from '@components/LlmPriceForm'
import { IconPrice } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import { type CreateLlmPriceInput, createLlmPrice } from '@lib/api'

function CreateLlmPriceContent() {
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
    router.push(CONTROL_ROUTES.costAndUsage.llmPrices)
  }

  async function handleSubmit(input: CreateLlmPriceInput) {
    setSaving(true)
    setError('')
    try {
      await createLlmPrice(input)
      showToast(`Price for ${input.provider}/${input.model} created.`, { tone: 'success' })
      backToList()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create price')
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
              icon={<IconPrice />}
              title="Add LLM price"
              subtitle="Set per-1M-token prices for a provider/model so cost budgets can price usage."
              backLabel="Back to prices"
              onBack={backToList}
              backDisabled={saving}
            />
          }
        >
          <LlmPriceForm
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

export default function CreateLlmPricePage() {
  return (
    <Suspense
      fallback={
        <BodyLoadingSkeleton
          backLabel="Back to prices"
          icon={<IconPrice />}
          primaryActionLabel="Add price"
          sections={3}
          subtitle="Set per-1M-token prices for a provider/model so cost budgets can price usage."
          title="Add LLM price"
        />
      }
    >
      <CreateLlmPriceContent />
    </Suspense>
  )
}
