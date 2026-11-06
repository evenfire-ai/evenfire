'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@components/AuthContext'
import { ModelReferences } from '@components/ModelReferences'
import { CONTROL_ROUTES } from '@constants/routes'
import { type AdminAttentionItem, getAdminAttention, isSilentApiError } from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'
import { attentionPairKey, buildModelIdsByPair, groupAttentionItems } from '@lib/llmModelAttention'
import type {
  AttentionReviewLinkProps,
  CatalogAttentionBannerProps,
  CatalogModelAttentionGroupProps,
} from './types'

const NO_MODELS: NonNullable<CatalogAttentionBannerProps['models']> = []

function plural(count: number): string {
  return count === 1 ? '' : 's'
}

function isAre(count: number): string {
  return count === 1 ? 'is' : 'are'
}

function itOrEach(count: number): string {
  return count === 1 ? 'it' : 'each one'
}

/** Link to the model's edit page; nothing while its allowlist row is not loaded. */
function AttentionReviewLink({ item, modelIdsByPair }: AttentionReviewLinkProps) {
  const modelId = modelIdsByPair.get(attentionPairKey(item))
  if (!modelId) return null
  const label = item.displayName ?? item.model
  return (
    <>
      {' '}
      <Link
        className="cu-link"
        href={CONTROL_ROUTES.llmModels.edit(modelId)}
        aria-label={`Review ${label} (${getProviderDisplayLabel(item.provider)} · ${item.model})`}
      >
        Review
      </Link>
    </>
  )
}

/** One group of reference-free items: a lede, then each model with its review link. */
function CatalogModelAttentionGroup({
  items,
  lede,
  modelIdsByPair,
}: CatalogModelAttentionGroupProps) {
  return (
    <div className="cu-model-attention__group">
      <p className="cu-model-attention__lede">{lede(items.length)}</p>
      <ul className="cu-model-attention__list">
        {items.map(item => {
          const label = item.displayName ?? item.model
          const providerLabel = getProviderDisplayLabel(item.provider)
          return (
            <li key={`${item.kind}/${item.provider}/${item.model}`}>
              <span className="cu-model-attention__head">
                <span className="cu-model-attention__name">{label}</span>{' '}
                <span className="cu-model-attention__meta">
                  ({item.displayName ? `${providerLabel} · ${item.model}` : providerLabel})
                </span>
                <AttentionReviewLink item={item} modelIdsByPair={modelIdsByPair} />
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Self-contained inline alert on the /llm-models catalog surface. Fetches
 * `GET /admin/attention` and lists, one group per kind:
 * - each `stale` catalog model still referenced by a live Host/grant, so the
 *   operator disables it (impact-gated PUT) or repoints those references;
 * - each enabled model the catalog marks deprecated;
 * - each enabled discovered model the latest catalog no longer lists.
 * The last two only inform: the operator reviews the model and disables it,
 * replaces it, or keeps it. A fetch failure degrades softly — the banner stays
 * hidden and never tumbles the surface.
 */
export function CatalogAttentionBanner({
  refreshSignal,
  models = NO_MODELS,
}: CatalogAttentionBannerProps = {}) {
  const { authState } = useAuth()
  const [items, setItems] = useState<AdminAttentionItem[]>([])

  // Re-fetches on mount and whenever `refreshSignal` changes — the surface bumps
  // it after a successful mutation so a just-resolved item stops showing. On
  // demand only; there is no polling.
  useEffect(() => {
    if (!(authState.isLoggedIn && !authState.isLoading)) return
    let cancelled = false
    async function load() {
      try {
        const report = await getAdminAttention()
        if (!cancelled) setItems(report.items)
      } catch (err) {
        if (isSilentApiError(err)) return
        // Advisory banner: a failure must never break the models surface.
        if (!cancelled) setItems([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [authState.isLoggedIn, authState.isLoading, refreshSignal])

  const modelIdsByPair = useMemo(() => buildModelIdsByPair(models), [models])
  // Unknown kinds never reach here: the fetch layer drops them while parsing.
  const { staleReferenced, deprecated, staleDiscovery } = groupAttentionItems(items)
  if (staleReferenced.length + deprecated.length + staleDiscovery.length === 0) return null

  return (
    <div className="cu-banner cu-banner--warning cu-model-attention" role="status">
      {staleReferenced.length > 0 ? (
        <div className="cu-model-attention__group">
          <p className="cu-model-attention__lede">
            <strong>{staleReferenced.length}</strong> model{plural(staleReferenced.length)}{' '}
            disappeared from the provider catalog but {isAre(staleReferenced.length)} still
            referenced. Disable {itOrEach(staleReferenced.length)} or update the references pointing
            at it.
          </p>
          <ul className="cu-model-attention__list">
            {staleReferenced.map(item => {
              const label = item.displayName ?? item.model
              const hostCount = item.hostsAffected.length
              const grantCount = item.grantsAffected.length
              return (
                <li key={`${item.provider}/${item.model}`}>
                  <span className="cu-model-attention__head">
                    <span className="cu-model-attention__name">{label}</span>{' '}
                    <span className="cu-model-attention__meta">
                      ({getProviderDisplayLabel(item.provider)})
                    </span>{' '}
                    — {hostCount} Host{plural(hostCount)} / {grantCount} grant
                    {plural(grantCount)} still use it.
                    <AttentionReviewLink item={item} modelIdsByPair={modelIdsByPair} />
                  </span>
                  <ModelReferences
                    hostsAffected={item.hostsAffected}
                    grantsAffected={item.grantsAffected}
                  />
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {deprecated.length > 0 ? (
        <CatalogModelAttentionGroup
          items={deprecated}
          modelIdsByPair={modelIdsByPair}
          lede={count => (
            <>
              <strong>{count}</strong> enabled model{plural(count)} {isAre(count)} marked deprecated
              in the provider catalog. Review {itOrEach(count)}: disable it, replace it with a newer
              model, or keep it enabled.
            </>
          )}
        />
      ) : null}
      {staleDiscovery.length > 0 ? (
        <CatalogModelAttentionGroup
          items={staleDiscovery}
          modelIdsByPair={modelIdsByPair}
          lede={count => (
            <>
              <strong>{count}</strong> enabled discovered model{plural(count)} {isAre(count)} no
              longer listed in the provider catalog. Review {itOrEach(count)}: disable it, replace
              it, or keep it if the provider still serves it.
            </>
          )}
        />
      ) : null}
    </div>
  )
}
