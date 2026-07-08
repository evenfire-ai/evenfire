'use client'

import React, { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmPriceForm } from '@components/LlmPriceForm'
import { IconPrice } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import {
  type BudgetRef,
  type CreateLlmPriceInput,
  type LlmModelPrice,
  getBudgetsUsingPrice,
  getLlmPrice,
  updateLlmPrice,
} from '@lib/api'

export default function EditLlmPricePage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = decodeURIComponent(params?.id ?? '')
  const { showToast } = useToast()

  const [price, setPrice] = useState<LlmModelPrice | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [budgetsUsingPrice, setBudgetsUsingPrice] = useState<BudgetRef[] | null>(null)

  function backToList() {
    router.push('/cost/llm-prices')
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const result = await getLlmPrice(id)
        if (cancelled) return
        setPrice(result)
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load price')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (id) void load()
    return () => {
      cancelled = true
    }
  }, [id])

  async function handleSubmit(input: CreateLlmPriceInput) {
    setSaving(true)
    setSaveError('')
    setBudgetsUsingPrice(null)
    try {
      await updateLlmPrice(id, input)
      showToast(`Price for ${input.provider}/${input.model} updated.`, { tone: 'success' })
      backToList()
    } catch (e) {
      const inUse = getBudgetsUsingPrice(e)
      if (inUse) {
        setBudgetsUsingPrice(inUse)
        showToast(
          `Can't update this price: used by ${inUse.length} budget${inUse.length === 1 ? '' : 's'}.`,
          { tone: 'error' }
        )
      } else {
        setSaveError(e instanceof Error ? e.message : 'Failed to update price')
      }
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
              title="Edit LLM price"
              subtitle="Update per-1M-token prices for this provider/model."
              backLabel="Back to prices"
              onBack={backToList}
              backDisabled={saving}
            />
          }
        >
          {loading ? (
            <div className="cu-px-form">
              <div className="cu-create-content">Loading price...</div>
            </div>
          ) : loadError ? (
            <div className="cu-px-form">
              <div className="cu-banner cu-banner--error" role="alert">
                {loadError}
              </div>
            </div>
          ) : price ? (
            <LlmPriceForm
              mode="edit"
              initial={price}
              saving={saving}
              error={saveError}
              budgetsUsingPrice={budgetsUsingPrice}
              onSubmit={handleSubmit}
              onCancel={backToList}
            />
          ) : null}
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
