'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconBudget } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { TokenBudgetForm } from '@components/TokenBudgetForm'
import {
  type CreateTokenBudgetInput,
  type UnpricedModel,
  createTokenBudget,
  getUnpricedModelsError,
} from '@lib/api'

export default function CreateTokenBudgetPage() {
  const router = useRouter()
  const { showToast } = useToast()

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [unpricedModelsError, setUnpricedModelsError] = useState<UnpricedModel[] | null>(null)

  function backToList() {
    router.push('/cost/token-budgets')
  }

  async function handleSubmit(input: CreateTokenBudgetInput) {
    setSaving(true)
    setError('')
    setUnpricedModelsError(null)
    try {
      await createTokenBudget(input)
      showToast(`Budget "${input.name}" created.`, { tone: 'success' })
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
        setError(e instanceof Error ? e.message : 'Failed to create budget')
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
              title="New token budget"
              subtitle="Cap LLM spend per dimension and watch it against live usage. P0c runs in observation mode."
              backLabel="Back to budgets"
              onBack={backToList}
              backDisabled={saving}
            />
          }
        >
          <TokenBudgetForm
            mode="create"
            saving={saving}
            error={error}
            unpricedModelsError={unpricedModelsError}
            onSubmit={handleSubmit}
            onCancel={backToList}
          />
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
