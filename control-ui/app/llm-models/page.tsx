'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmDiscoveryPanel } from '@components/LlmDiscoveryPanel'
import { LlmModelTable } from '@components/LlmModelTable'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type LlmAllowedModel,
  type UnpricedModel,
  deleteLlmModel,
  getLlmModels,
  getUnpricedModels,
  isLlmModelConfigMapDeferred,
  isSilentApiError,
} from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'
import { buildUnpricedKeys } from '@lib/llmModelUnpriced'

// Warning surfaced when a mutation persisted but the runtime ConfigMap write is
// delayed (503 configmap_write_failed, spec §3-R3.4): the change is saved.
const CONFIGMAP_DEFERRED_WARNING =
  'Saved. Propagation to the cluster is delayed and will reconcile shortly.'

function LlmModelsContent() {
  const { authState } = useAuth()
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

  const [models, setModels] = useState<LlmAllowedModel[]>([])
  const [unpriced, setUnpriced] = useState<UnpricedModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const unpricedKeys = useMemo(() => buildUnpricedKeys(unpriced), [unpriced])

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      // Unpriced surfacing is best-effort: a failure there must not hide models.
      const [modelsResult, unpricedResult] = await Promise.allSettled([
        getLlmModels(),
        getUnpricedModels(),
      ])
      if (modelsResult.status === 'fulfilled') {
        setModels(modelsResult.value.rows ?? [])
      } else if (!isSilentApiError(modelsResult.reason)) {
        throw modelsResult.reason
      }
      if (unpricedResult.status === 'fulfilled') {
        setUnpriced(unpricedResult.value.rows ?? [])
      } else {
        setUnpriced([])
      }
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load allowed models')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(model: LlmAllowedModel) {
    const label = `${getProviderDisplayLabel(model.provider)}/${model.model}`
    const shouldDelete = await confirm({
      title: 'Delete model',
      message: `Remove ${label} from the allowlist? Existing agents keep running, but this model can no longer be selected.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return
    setDeletingId(model.id)
    setError('')
    try {
      await deleteLlmModel(model.id)
      await loadAll()
      showToast(`${label} removed from the allowlist.`, { tone: 'success' })
    } catch (e) {
      if (isSilentApiError(e)) return
      // The row was deleted; only ConfigMap propagation is delayed.
      if (isLlmModelConfigMapDeferred(e)) {
        await loadAll()
        showToast(`${label} removed. ${CONFIGMAP_DEFERRED_WARNING}`, { tone: 'info' })
        return
      }
      setError(e instanceof Error ? e.message : `Failed to delete ${label}`)
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
    <div className="cu-llm-models-layout">
      {error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : null}
      <section className="cu-llm-models-lifecycle" aria-label="Model lifecycle">
        <strong>One inventory, explicit provenance and lifecycle</strong>
        <span className="cu-llm-models-lifecycle__item">
          <span className="cu-px-badge cu-px-badge--off">Manual</span>
          Added and maintained by an operator
        </span>
        <span className="cu-llm-models-lifecycle__item">
          <span className="cu-px-badge cu-px-badge--info">Discovered</span>
          Synced into review and disabled by default
        </span>
        <span className="cu-llm-models-lifecycle__item">
          <span className="cu-px-badge cu-px-badge--warn">Stale</span>
          Missing from the latest live catalog, never auto-removed
        </span>
      </section>
      <LlmModelTable
        items={models}
        unpricedKeys={unpricedKeys}
        onCreate={() => router.push(CONTROL_ROUTES.llmModels.new)}
        onEdit={id => router.push(CONTROL_ROUTES.llmModels.edit(id))}
        onDelete={handleDelete}
        onRefresh={loadAll}
        deletingId={deletingId}
        refreshing={loading}
        loading={loading && models.length === 0}
      />
      <LlmDiscoveryPanel
        items={models}
        loading={loading && models.length === 0}
        onRefresh={loadAll}
      />
      {confirmDialog}
    </div>
  )
}

export default function LlmModelsPage() {
  return (
    <AuthGate>
      <DashboardLayout>
        <LlmModelsContent />
      </DashboardLayout>
    </AuthGate>
  )
}
