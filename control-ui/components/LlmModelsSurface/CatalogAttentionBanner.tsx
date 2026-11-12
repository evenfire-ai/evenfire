'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@components/AuthContext'
import { Button } from '@components/ui'
import { type AdminAttentionItem, getAdminAttention, isSilentApiError } from '@lib/api'
import { buildModelIdsByPair, groupAttentionItems } from '@lib/llmModelAttention'
import { CatalogAttentionDialog } from './CatalogAttentionDialog'
import type { CatalogAttentionBannerProps } from './types'

const NO_MODELS: NonNullable<CatalogAttentionBannerProps['models']> = []

/**
 * Self-contained one-line alert on the /llm-models catalog surface. Fetches
 * `GET /admin/attention` and counts, one segment per kind (the detail opens in
 * CatalogAttentionDialog):
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
  const [reviewOpen, setReviewOpen] = useState(false)

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
  const groups = groupAttentionItems(items)
  const { staleReferenced, deprecated, staleDiscovery } = groups
  const empty = staleReferenced.length + deprecated.length + staleDiscovery.length === 0
  // `return null` does not unmount this component, so without this reset a
  // dialog left open when the feed empties (an empty or a failed refetch) would
  // reappear on its own the next time the feed has items.
  if (empty && reviewOpen) setReviewOpen(false)
  if (empty) return null

  // No total: one model can sit in two groups (deprecated and then dropped, or
  // dropped while still referenced), so a sum would overcount.
  const segments = [
    staleReferenced.length > 0 ? `${staleReferenced.length} still referenced` : null,
    deprecated.length > 0 ? `${deprecated.length} deprecated` : null,
    staleDiscovery.length > 0 ? `${staleDiscovery.length} no longer listed` : null,
  ].filter((segment): segment is string => segment !== null)

  return (
    <div className="cu-banner cu-banner--warning cu-llm-models-banner" role="status">
      <span>Models need review: {segments.join(' · ')}</span>{' '}
      <Button type="button" variant="ghost" size="sm" onClick={() => setReviewOpen(true)}>
        Review models
      </Button>
      <CatalogAttentionDialog
        open={reviewOpen}
        onDismiss={() => setReviewOpen(false)}
        groups={groups}
        modelIdsByPair={modelIdsByPair}
      />
    </div>
  )
}
