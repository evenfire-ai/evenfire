'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmDiscoveryPanel } from '@components/LlmDiscoveryPanel'
import { LlmModelTable } from '@components/LlmModelTable'
import { TabBar } from '@components/TabBar'
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
import type { LlmModelsSurfaceProps, LlmModelsTab } from './types'

const CONFIGMAP_DEFERRED_WARNING =
  'Saved. Propagation to the cluster is delayed and will reconcile shortly.'

function LlmModelsContent({ activeTab }: LlmModelsSurfaceProps) {
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
      const modelsResultPromise = Promise.allSettled([getLlmModels()])
      const unpricedResultPromise =
        activeTab === 'catalog' ? Promise.allSettled([getUnpricedModels()]) : null
      const [modelsResult] = await modelsResultPromise
      if (modelsResult.status === 'fulfilled') {
        setModels(modelsResult.value.rows ?? [])
      } else if (!isSilentApiError(modelsResult.reason)) {
        throw modelsResult.reason
      }

      if (!unpricedResultPromise) {
        setUnpriced([])
        return
      }
      const [unpricedResult] = await unpricedResultPromise
      if (unpricedResult.status === 'fulfilled') {
        setUnpriced(unpricedResult.value.rows ?? [])
      } else {
        setUnpriced([])
      }
    } catch (caught) {
      if (isSilentApiError(caught)) return
      setError(caught instanceof Error ? caught.message : 'Failed to load allowed models')
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
    } catch (caught) {
      if (isSilentApiError(caught)) return
      if (isLlmModelConfigMapDeferred(caught)) {
        await loadAll()
        showToast(`${label} removed. ${CONFIGMAP_DEFERRED_WARNING}`, { tone: 'info' })
        return
      }
      setError(caught instanceof Error ? caught.message : `Failed to delete ${label}`)
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => {
    if (authState.isLoggedIn && !authState.isLoading) {
      void loadAll()
    }
  }, [activeTab, authState.isLoggedIn, authState.isLoading])

  const tabs = [
    {
      value: 'catalog' as const,
      href: CONTROL_ROUTES.llmModels.root,
      label: 'Catalog',
    },
    {
      value: 'discovery' as const,
      href: CONTROL_ROUTES.llmModels.discovery,
      label: 'Discovery review',
    },
  ]
  const navigation = (
    <TabBar<LlmModelsTab>
      activeValue={activeTab}
      ariaLabel="LLM model management"
      className="cu-tabs--flush-top"
      options={tabs}
    />
  )

  return (
    <div className="cu-llm-models-layout">
      {error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : null}
      {activeTab === 'catalog' ? (
        <LlmModelTable
          items={models}
          navigation={navigation}
          unpricedKeys={unpricedKeys}
          onCreate={() => router.push(CONTROL_ROUTES.llmModels.new)}
          onEdit={id => router.push(CONTROL_ROUTES.llmModels.edit(id))}
          onDelete={handleDelete}
          onRefresh={loadAll}
          deletingId={deletingId}
          refreshing={loading}
          loading={loading && models.length === 0}
        />
      ) : (
        <LlmDiscoveryPanel
          items={models}
          loading={loading && models.length === 0}
          navigation={navigation}
          onRefresh={loadAll}
        />
      )}
      {confirmDialog}
    </div>
  )
}

export function LlmModelsSurface(props: LlmModelsSurfaceProps) {
  return (
    <AuthGate>
      <DashboardLayout>
        <LlmModelsContent {...props} />
      </DashboardLayout>
    </AuthGate>
  )
}
