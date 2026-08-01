'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { LlmPriceTable } from '@components/LlmPriceTable'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type BudgetRef,
  type LlmModelPrice,
  type UnpricedModel,
  deleteLlmPrice,
  getBudgetsUsingPrice,
  getLlmPrices,
  getUnpricedModels,
  isSilentApiError,
} from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'

export default function LlmPricesPage() {
  const { authState } = useAuth()
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

  const [prices, setPrices] = useState<LlmModelPrice[]>([])
  const [unpriced, setUnpriced] = useState<UnpricedModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Cost budgets still pinning a price whose delete was rejected with 409.
  const [deleteBlockedBudgets, setDeleteBlockedBudgets] = useState<BudgetRef[] | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      // Unpriced surfacing is best-effort: a failure there must not hide prices.
      const [pricesResult, unpricedResult] = await Promise.allSettled([
        getLlmPrices(),
        getUnpricedModels(),
      ])
      if (pricesResult.status === 'fulfilled') {
        setPrices(pricesResult.value.rows ?? [])
      } else if (!isSilentApiError(pricesResult.reason)) {
        throw pricesResult.reason
      }
      if (unpricedResult.status === 'fulfilled') {
        setUnpriced(unpricedResult.value.rows ?? [])
      } else {
        setUnpriced([])
      }
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load LLM prices')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(price: LlmModelPrice) {
    const label = `${getProviderDisplayLabel(price.provider)}/${price.model}`
    const shouldDelete = await confirm({
      title: 'Delete price',
      message: `Delete the price for ${label}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return
    setDeletingId(price.id)
    setError('')
    setDeleteBlockedBudgets(null)
    try {
      await deleteLlmPrice(price.id)
      await loadAll()
      showToast(`Price for ${label} deleted.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      const inUse = getBudgetsUsingPrice(e)
      if (inUse) {
        setDeleteBlockedBudgets(inUse)
        showToast(
          `Can't delete this price: used by ${inUse.length} budget${inUse.length === 1 ? '' : 's'}.`,
          { tone: 'error' }
        )
      } else {
        setError(e instanceof Error ? e.message : `Failed to delete price for ${label}`)
      }
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => {
    if (authState.isLoggedIn && !authState.isLoading) {
      void loadAll()
    }
  }, [authState.isLoggedIn, authState.isLoading])

  return (
    <>
      {error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : null}
      {deleteBlockedBudgets && deleteBlockedBudgets.length > 0 ? (
        <div className="cu-banner cu-banner--error" role="alert">
          Can&apos;t delete this price: it is still pinned by{' '}
          <strong>{deleteBlockedBudgets.length}</strong> cost budget
          {deleteBlockedBudgets.length === 1 ? '' : 's'}. Update or remove the model from{' '}
          {deleteBlockedBudgets.map((budget, index) => (
            <React.Fragment key={budget.id}>
              {index > 0 ? ', ' : ''}
              <Link
                href={CONTROL_ROUTES.costAndUsage.editTokenBudget(budget.id)}
                className="cu-link"
              >
                {budget.name}
              </Link>
            </React.Fragment>
          ))}{' '}
          first.
        </div>
      ) : null}
      <LlmPriceTable
        items={prices}
        unpricedItems={unpriced}
        onCreate={() => router.push(CONTROL_ROUTES.costAndUsage.newLlmPrice())}
        onAddMissingPrice={model =>
          router.push(
            CONTROL_ROUTES.costAndUsage.newLlmPrice({
              provider: model.provider,
              model: model.model,
            })
          )
        }
        onEdit={id => router.push(CONTROL_ROUTES.costAndUsage.editLlmPrice(id))}
        onDelete={handleDelete}
        onRefresh={loadAll}
        deletingId={deletingId}
        refreshing={loading}
        loading={loading && prices.length === 0}
      />
      {confirmDialog}
    </>
  )
}
