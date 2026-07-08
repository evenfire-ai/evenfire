'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useToast } from '@components/Toast'
import { TokenBudgetTable } from '@components/TokenBudgetTable'
import {
  type TokenBudget,
  deleteTokenBudget,
  getAdminTeams,
  getAdminUsers,
  getTokenBudgets,
  isSilentApiError,
  setTokenBudgetEnabled,
} from '@lib/api'
import type { BudgetScopeLookups } from '@lib/budgets'

export default function TokenBudgetsPage() {
  const { authState } = useAuth()
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

  const [budgets, setBudgets] = useState<TokenBudget[]>([])
  const [lookups, setLookups] = useState<BudgetScopeLookups>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      // Budgets are the primary data; team/user name maps are best-effort so a
      // failure there only falls back to showing UUIDs, never hides budgets.
      const [budgetsResult, teamsResult, usersResult] = await Promise.allSettled([
        getTokenBudgets(),
        getAdminTeams(),
        getAdminUsers(),
      ])
      if (budgetsResult.status === 'fulfilled') {
        setBudgets(budgetsResult.value.rows ?? [])
      } else if (!isSilentApiError(budgetsResult.reason)) {
        throw budgetsResult.reason
      }
      const next: BudgetScopeLookups = {}
      if (teamsResult.status === 'fulfilled') {
        next.team = Object.fromEntries((teamsResult.value.items ?? []).map(t => [t.id, t.name]))
      }
      if (usersResult.status === 'fulfilled') {
        next.user = Object.fromEntries(
          (usersResult.value.items ?? []).map(u => [u.id, u.displayName || u.name || u.email])
        )
      }
      setLookups(next)
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load token budgets')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(budget: TokenBudget) {
    const shouldDelete = await confirm({
      title: 'Delete budget',
      message: `Delete the budget "${budget.name}"?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return
    setDeletingId(budget.id)
    setError('')
    try {
      await deleteTokenBudget(budget.id)
      await loadAll()
      showToast(`Budget "${budget.name}" deleted.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : `Failed to delete budget "${budget.name}"`)
    } finally {
      setDeletingId(null)
    }
  }

  async function handleToggle(budget: TokenBudget) {
    setTogglingId(budget.id)
    setError('')
    try {
      await setTokenBudgetEnabled(budget.id, !budget.enabled)
      await loadAll()
      showToast(`Budget "${budget.name}" ${budget.enabled ? 'disabled' : 'enabled'}.`, {
        tone: 'success',
      })
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : `Failed to update budget "${budget.name}"`)
    } finally {
      setTogglingId(null)
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
      <TokenBudgetTable
        items={budgets}
        lookups={lookups}
        onCreate={() => router.push('/cost/token-budgets/new')}
        onEdit={id => router.push(`/cost/token-budgets/${encodeURIComponent(id)}/edit`)}
        onDelete={handleDelete}
        onToggle={handleToggle}
        onRefresh={loadAll}
        deletingId={deletingId}
        togglingId={togglingId}
        refreshing={loading}
        loading={loading && budgets.length === 0}
      />
      {confirmDialog}
    </>
  )
}
