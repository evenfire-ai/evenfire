'use client'

import React, { useEffect, useState } from 'react'
import { useAuth } from '@components/AuthContext'
import { ModelReferences } from '@components/ModelReferences'
import { type AdminAttentionItem, getAdminAttention, isSilentApiError } from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'
import type { CatalogAttentionBannerProps } from './types'

// The only attention kind today; the feed's `kind` is an open union, so the
// banner renders known kinds and ignores anything else (spec Fase 5, Pieza C).
const STALE_MODEL_REFERENCED = 'stale_model_referenced'

/**
 * Self-contained inline alert on the /llm-models catalog surface. Fetches
 * `GET /admin/attention` and lists each `stale` catalog model that is still
 * referenced by a live Host/grant, so the operator disables it (impact-gated
 * PUT) or repoints those references. A fetch failure degrades softly — the
 * banner stays hidden and never tumbles the surface.
 */
export function CatalogAttentionBanner({ refreshSignal }: CatalogAttentionBannerProps = {}) {
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

  // Known-kind items only. An unknown `kind` is ignored (never crashes); a feed
  // with no known items renders no banner.
  const staleItems = items.filter(item => item.kind === STALE_MODEL_REFERENCED)
  if (staleItems.length === 0) return null

  const plural = staleItems.length === 1 ? '' : 's'
  return (
    <div className="cu-banner cu-banner--warning cu-model-attention" role="status">
      <p className="cu-model-attention__lede">
        <strong>{staleItems.length}</strong> model{plural} disappeared from the provider catalog but{' '}
        {staleItems.length === 1 ? 'is' : 'are'} still referenced. Disable{' '}
        {staleItems.length === 1 ? 'it' : 'each one'} or update the references pointing at it.
      </p>
      <ul className="cu-model-attention__list">
        {staleItems.map(item => {
          const label = item.displayName ?? item.model
          const hostCount = item.hostsAffected.length
          const grantCount = item.grantsAffected.length
          return (
            <li key={`${item.provider}/${item.model}`} className="cu-model-attention__item">
              <span className="cu-model-attention__head">
                <span className="cu-model-attention__name">{label}</span>{' '}
                <span className="cu-model-attention__meta">
                  ({getProviderDisplayLabel(item.provider)})
                </span>{' '}
                — {hostCount} Host{hostCount === 1 ? '' : 's'} / {grantCount} grant
                {grantCount === 1 ? '' : 's'} still use it.
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
  )
}
