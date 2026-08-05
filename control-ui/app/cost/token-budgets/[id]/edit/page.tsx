'use client'

import React, { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { FormSectionsSkeleton } from '@components/BodyLoadingSkeleton'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconBudget } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { TokenBudgetForm } from '@components/TokenBudgetForm'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type CreateTokenBudgetInput,
  type TokenBudget,
  type UnpricedModel,
  getTokenBudget,
  getUnpricedModelsError,
  updateTokenBudget,
} from '@lib/api'

export default function EditTokenBudgetPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = decodeURIComponent(params?.id ?? '')
  const { showToast } = useToast()

  const [budget, setBudget] = useState<TokenBudget | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [unpricedModelsError, setUnpricedModelsError] = useState<UnpricedModel[] | null>(null)

  function backToList() {
    router.push(CONTROL_ROUTES.costAndUsage.tokenBudgets)
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const result = await getTokenBudget(id)
        if (cancelled) return
        setBudget(result)
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load budget')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (id) void load()
    return () => {
      cancelled = true
    }
  }, [id])

  async function handleSubmit(input: CreateTokenBudgetInput) {
    setSaving(true)
    setSaveError('')
    setUnpricedModelsError(null)
    try {
      await updateTokenBudget(id, input)
      showToast(`Budget "${input.name}" updated.`, { tone: 'success' })
      backToList()
    } catch (e) {
      const unpriced = getUnpricedModelsError(e)
      if (unpriced) {
        setUnpricedModelsError(unpriced)
        showToast(
          `Can't save: ${unpriced.length} model${unpriced.length === 1 ? '' : 's'} have no active price — add prices first.`,
          { tone: 'error' }
        )
      } else {
        setSaveError(e instanceof Error ? e.message : 'Failed to update budget')
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
              icon={<IconBudget />}
              title="Edit token budget"
              subtitle="Update this budget's limit, period, and scope."
              backLabel="Back to budgets"
              onBack={backToList}
              backDisabled={saving}
            />
          }
        >
          {loading ? (
            <FormSectionsSkeleton
              className="cu-tb-form"
              label="Token budget"
              primaryActionLabel="Save budget"
              sections={3}
            />
          ) : loadError ? (
            <div className="cu-tb-form">
              <div className="cu-banner cu-banner--error" role="alert">
                {loadError}
              </div>
            </div>
          ) : budget ? (
            <TokenBudgetForm
              mode="edit"
              initial={budget}
              saving={saving}
              error={saveError}
              unpricedModelsError={unpricedModelsError}
              onSubmit={handleSubmit}
              onCancel={backToList}
            />
          ) : null}
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
