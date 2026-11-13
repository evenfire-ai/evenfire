'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@components/AuthContext'
import { useToast } from '@components/Toast'
import { Button } from '@components/ui'
import {
  type AdminAckableAttentionItem,
  type AdminAttentionItem,
  type AdminModelAttentionItem,
  ackAdminAttention,
  getAdminAttention,
  isAttentionEpisodeChanged,
  isLlmModelConfigMapDeferred,
  isSilentApiError,
  unackAdminAttention,
  updateLlmModel,
} from '@lib/api'
import {
  attentionItemKey,
  attentionPairKey,
  buildModelIdsByPair,
  groupAttentionItems,
  splitAcknowledged,
} from '@lib/llmModelAttention'
import { CatalogAttentionDialog } from './CatalogAttentionDialog'
import type { CatalogAttentionBannerProps } from './types'

const NO_MODELS: NonNullable<CatalogAttentionBannerProps['models']> = []

const EPISODE_CHANGED_NOTICE = 'This item changed, review it again.'

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * Self-contained one-line alert on the /llm-models catalog surface. Fetches
 * `GET /admin/attention?includeAcknowledged=1` and counts the items still to
 * review, one segment per kind (the detail opens in CatalogAttentionDialog):
 * - each enabled model the catalog no longer lists while somebody uses it;
 * - each enabled model the catalog marks deprecated while somebody uses it.
 * Items the operator already reviewed sit in the dialog's Reviewed section and
 * never count here. A fetch failure degrades softly — the banner stays hidden
 * and never tumbles the surface.
 *
 * The server is the only state: every action ends in a reload of the feed, with
 * no optimistic update, and only the buttons of the item in flight are locked.
 */
export function CatalogAttentionBanner({
  refreshSignal,
  models = NO_MODELS,
}: CatalogAttentionBannerProps = {}) {
  const { authState } = useAuth()
  const { showToast } = useToast()
  const [items, setItems] = useState<AdminAttentionItem[]>([])
  const [reviewOpen, setReviewOpen] = useState(false)
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [itemErrors, setItemErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  // The feed read that may still land: a newer read supersedes it, so an older
  // response arriving late can never overwrite a newer one.
  const currentLoad = useRef<AbortController | null>(null)

  async function loadFeed() {
    currentLoad.current?.abort()
    const controller = new AbortController()
    currentLoad.current = controller
    try {
      const report = await getAdminAttention({
        includeAcknowledged: true,
        signal: controller.signal,
      })
      if (currentLoad.current !== controller) return
      setItems(report.items)
      // An error belongs to an item; once the item leaves the feed it points at nothing.
      const present = new Set(report.items.map(attentionItemKey))
      setItemErrors(current =>
        [...current.keys()].every(key => present.has(key))
          ? current
          : new Map([...current].filter(([key]) => present.has(key)))
      )
    } catch (err) {
      if (currentLoad.current !== controller || isSilentApiError(err)) return
      // Advisory banner: a failure must never break the models surface.
      setItems([])
    }
  }

  // Re-fetches on mount and whenever `refreshSignal` changes — the surface bumps
  // it after a successful mutation so a just-resolved item stops showing. On
  // demand only; there is no polling.
  useEffect(() => {
    if (!(authState.isLoggedIn && !authState.isLoading)) return
    void loadFeed()
    return () => {
      currentLoad.current?.abort()
      currentLoad.current = null
    }
  }, [authState.isLoggedIn, authState.isLoading, refreshSignal])

  function setBusy(key: string, busy: boolean) {
    setBusyKeys(current => {
      const next = new Set(current)
      if (busy) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function setItemError(key: string, message: string | null) {
    setItemErrors(current => {
      if (message === null && !current.has(key)) return current
      const next = new Map(current)
      if (message === null) next.delete(key)
      else next.set(key, message)
      return next
    })
  }

  /**
   * Runs one item's action and then reloads the feed. A 409
   * `attention_episode_changed` reloads too, so the operator sees the item as it
   * is now. Any other failure leaves the feed alone and shows the error on the
   * item, which stays where it was so the operator can retry.
   */
  async function runItemAction(
    item: AdminAttentionItem,
    action: () => Promise<void>,
    describeFailure: (err: unknown) => string
  ) {
    const key = attentionItemKey(item)
    setBusy(key, true)
    setItemError(key, null)
    try {
      await action()
      await loadFeed()
    } catch (err) {
      if (isSilentApiError(err)) return
      if (isAttentionEpisodeChanged(err)) {
        showToast(EPISODE_CHANGED_NOTICE, { tone: 'info' })
        await loadFeed()
        return
      }
      setItemError(key, describeFailure(err))
    } finally {
      setBusy(key, false)
    }
  }

  function markReviewed(item: AdminAckableAttentionItem) {
    void runItemAction(
      item,
      () => ackAdminAttention(item),
      err => errorMessage(err, 'Failed to mark the model as reviewed')
    )
  }

  // The pin must land before the acknowledgement: the ack only records that the
  // operator decided, the PUT is the decision. A failed ack after a successful
  // PUT keeps the PUT; retrying repeats both, and repeating the pin is harmless.
  function keepEnabled(item: AdminAckableAttentionItem, modelId: string) {
    let pinned = false
    void runItemAction(
      item,
      async () => {
        try {
          await updateLlmModel(modelId, { enabled: true, pinEnabled: true })
        } catch (err) {
          // The row was saved; only the cluster propagation is delayed.
          if (!isLlmModelConfigMapDeferred(err)) throw err
        }
        pinned = true
        await ackAdminAttention(item)
      },
      err =>
        pinned
          ? `Kept enabled, but marking it as reviewed failed: ${errorMessage(err, 'request failed')}. Try again.`
          : errorMessage(err, 'Failed to keep the model enabled')
    )
  }

  function undoReviewed(item: AdminModelAttentionItem) {
    void runItemAction(
      item,
      () => unackAdminAttention(item),
      err => errorMessage(err, 'Failed to undo the review')
    )
  }

  const modelIdsByPair = useMemo(() => buildModelIdsByPair(models), [models])
  const { pending, reviewed } = splitAcknowledged(items)
  // Unknown kinds never reach here: the fetch layer drops them while parsing.
  const groups = groupAttentionItems(pending)
  const { staleReferenced, deprecated, staleDiscovery } = groups
  const nothingPending = staleReferenced.length + deprecated.length + staleDiscovery.length === 0
  const empty = nothingPending && reviewed.length === 0
  // `return null` does not unmount this component, so without this reset a
  // dialog left open when the feed empties (an empty or a failed refetch) would
  // reappear on its own the next time the feed has items. Reviewed items keep it
  // open: they are where the operator undoes a review.
  if (empty && reviewOpen) setReviewOpen(false)
  if (empty) return null

  // No total: one model can sit in two groups (deprecated and then dropped, or
  // dropped while still referenced), so a sum would overcount.
  const segments = [
    staleReferenced.length > 0 ? `${staleReferenced.length} still referenced` : null,
    deprecated.length > 0 ? `${deprecated.length} deprecated` : null,
    staleDiscovery.length > 0 ? `${staleDiscovery.length} no longer listed` : null,
  ].filter((segment): segment is string => segment !== null)

  // One element for both lines, so the dialog stays mounted (and open) when the
  // last pending item moves to Reviewed.
  return (
    <div
      className={
        nothingPending
          ? 'cu-banner cu-llm-models-banner cu-llm-models-banner--quiet'
          : 'cu-banner cu-banner--warning cu-llm-models-banner'
      }
      role="status"
    >
      {nothingPending ? (
        <span>
          {reviewed.length} model{reviewed.length === 1 ? '' : 's'} reviewed
        </span>
      ) : (
        <span>Models need review: {segments.join(' · ')}</span>
      )}{' '}
      <Button type="button" variant="ghost" size="sm" onClick={() => setReviewOpen(true)}>
        {nothingPending ? 'Show reviewed' : 'Review models'}
      </Button>
      <CatalogAttentionDialog
        open={reviewOpen}
        onDismiss={() => setReviewOpen(false)}
        groups={groups}
        reviewed={reviewed}
        modelIdsByPair={modelIdsByPair}
        busyKeys={busyKeys}
        itemErrors={itemErrors}
        onKeepEnabled={item => {
          const modelId = modelIdsByPair.get(attentionPairKey(item))
          if (modelId) keepEnabled(item, modelId)
        }}
        onMarkReviewed={markReviewed}
        onUndoReviewed={undoReviewed}
      />
    </div>
  )
}
