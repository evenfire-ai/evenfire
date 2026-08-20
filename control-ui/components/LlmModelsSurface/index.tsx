'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmDiscoveryPanel } from '@components/LlmDiscoveryPanel'
import { LlmModelTable } from '@components/LlmModelTable'
import { ModelReferences } from '@components/ModelReferences'
import { TabBar } from '@components/TabBar'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type LlmAllowedModel,
  type UnpricedModel,
  deleteLlmModel,
  getLlmModels,
  getModelInUseImpact,
  getUnpricedModels,
  isLlmModelConfigMapDeferred,
  isSilentApiError,
} from '@lib/api'
import {
  isCodexSubscriptionUiEnabled,
  loadCodexSubscriptionCapability,
} from '@lib/codexSubscriptionFeature'
import { getProviderDisplayLabel } from '@lib/llm'
import { buildUnpricedKeys } from '@lib/llmModelUnpriced'
import { CatalogAttentionBanner } from './CatalogAttentionBanner'
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
  // Bumped after each successful mutation so the attention banner re-fetches
  // and drops any item the operator just resolved (on demand, no polling).
  const [attentionRefreshKey, setAttentionRefreshKey] = useState(0)
  const [codexEnabled, setCodexEnabled] = useState(false)

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
    await deleteWithImpactGate(model, label, false)
  }

  // A first delete goes without `?force`. If control-api answers 409
  // `model_in_use`, show the impact and let the operator confirm a forced retry
  // — never force automatically (spec Fase 3/5).
  async function deleteWithImpactGate(model: LlmAllowedModel, label: string, force: boolean) {
    setDeletingId(model.id)
    setError('')
    let impact: ReturnType<typeof getModelInUseImpact> = null
    try {
      await deleteLlmModel(model.id, force ? { force: true } : {})
      await loadAll()
      setAttentionRefreshKey(key => key + 1)
      showToast(`${label} removed from the allowlist.`, { tone: 'success' })
      return
    } catch (caught) {
      if (isSilentApiError(caught)) return
      if (isLlmModelConfigMapDeferred(caught)) {
        await loadAll()
        setAttentionRefreshKey(key => key + 1)
        showToast(`${label} removed. ${CONFIGMAP_DEFERRED_WARNING}`, { tone: 'info' })
        return
      }
      impact = getModelInUseImpact(caught)
      if (!impact) {
        setError(caught instanceof Error ? caught.message : `Failed to delete ${label}`)
        return
      }
    } finally {
      setDeletingId(null)
    }

    const forceRemove = await confirm({
      title: 'Model still in use',
      message: `${label} is still referenced. Removing it leaves these references pointing at a deleted model:`,
      details: (
        <ModelReferences
          hostsAffected={impact.hostsAffected}
          grantsAffected={impact.grantsAffected}
        />
      ),
      confirmLabel: 'Remove anyway',
      tone: 'danger',
    })
    if (forceRemove) await deleteWithImpactGate(model, label, true)
  }

  useEffect(() => {
    if (authState.isLoggedIn && !authState.isLoading) {
      void loadAll()
      void loadCodexSubscriptionCapability().then(capability => {
        setCodexEnabled(isCodexSubscriptionUiEnabled(capability))
      })
    }
  }, [activeTab, authState.isLoggedIn, authState.isLoading])

  const discoveryReviewCount = useMemo(
    () =>
      models.filter(model => model.source === 'discovery' && !model.enabled && !model.stale).length,
    [models]
  )

  const tabs = [
    {
      value: 'catalog' as const,
      href: CONTROL_ROUTES.llmModels.root,
      label: models.length > 0 ? `Catalog (${models.length})` : 'Catalog',
    },
    {
      value: 'discovery' as const,
      href: CONTROL_ROUTES.llmModels.discovery,
      label:
        discoveryReviewCount > 0
          ? `Discovery review (${discoveryReviewCount})`
          : 'Discovery review',
    },
  ]
  const navigation = (
    <TabBar<LlmModelsTab> activeValue={activeTab} ariaLabel="LLM model management" options={tabs} />
  )

  return (
    <div className="cu-llm-models-layout">
      {error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : null}
      {activeTab === 'catalog' ? (
        <CatalogAttentionBanner refreshSignal={attentionRefreshKey} />
      ) : null}
      {activeTab === 'catalog' && codexEnabled ? (
        <p>
          <a href={CONTROL_ROUTES.llmModels.codexSubscription}>Codex subscription</a>
        </p>
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
