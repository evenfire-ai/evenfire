'use client'

import React, { useEffect, useState } from 'react'
import { useConfirmDialog } from '../../components/ConfirmDialog'
import { DashboardLayout } from '../../components/DashboardLayout'
import { GuardrailHooksTable } from '../../components/GuardrailHooksTable'
import type { LlmHookRef } from '../../components/GuardrailHooksTable.types'
import { useToast } from '../../components/Toast'
import { deleteLlmHook, getLlmHooks, isSilentApiError } from '../../lib/api'
import type { LlmHookResource } from '../../lib/api'

export default function GuardrailsPage() {
  const { showToast } = useToast()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hooks, setHooks] = useState<LlmHookResource[]>([])
  const [uninstallingKey, setUninstallingKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const result = await getLlmHooks()
      setHooks((result.items || []) as LlmHookResource[])
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load guardrail hooks')
    } finally {
      setLoading(false)
    }
  }

  async function handleUninstall(hook: LlmHookRef) {
    const shouldDelete = await confirm({
      title: 'Uninstall Guardrail Hook',
      message: `Uninstall guardrail hook ${hook.name}? This removes the LlmHook and its deployment.`,
      confirmLabel: 'Uninstall',
      tone: 'danger',
    })
    if (!shouldDelete) return
    setUninstallingKey(hook.name)
    setError('')
    try {
      await deleteLlmHook(hook.name)
      await loadAll()
      showToast(`Guardrail hook ${hook.name} uninstalled.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : `Failed to uninstall ${hook.name}`)
    } finally {
      setUninstallingKey(null)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  return (
    <DashboardLayout>
      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
      <GuardrailHooksTable
        items={hooks}
        onUninstall={handleUninstall}
        uninstallingKey={uninstallingKey}
        onRefresh={loadAll}
        refreshing={loading}
        loading={loading && hooks.length === 0}
      />
      {confirmDialog}
    </DashboardLayout>
  )
}
