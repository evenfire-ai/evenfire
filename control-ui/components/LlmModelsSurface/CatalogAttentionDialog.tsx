'use client'

import React, { useRef } from 'react'
import Link from 'next/link'
import { DataTable, DialogShell } from '@clerum/frontend-components'
import { LlmProviderIcon } from '@components/LlmProviderIcon'
import { ModelReferences } from '@components/ModelReferences'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { Button } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import type { AdminAttentionItem } from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'
import { attentionItemKey, attentionPairKey, isAckableAttentionItem } from '@lib/llmModelAttention'
import type {
  AttentionItemActionsProps,
  AttentionModelCellProps,
  AttentionProviderCellProps,
  AttentionReviewLinkProps,
  AttentionSectionProps,
  AttentionUsedByCellProps,
  CatalogAttentionDialogProps,
  ReviewedAttentionSectionProps,
} from './types'

// Fixed widths on the outer columns keep Provider aligned across the tables:
// `.eft-table` lays out automatically and the legacy no-longer-listed group has
// no `Used by` column, so a minWidth would let each table drift.
const PROVIDER_COLUMN: TableHeaderColumn = { key: 'provider', label: 'Provider', width: '12rem' }
const MODEL_COLUMN: TableHeaderColumn = { key: 'model', label: 'Model' }
const USED_BY_COLUMN: TableHeaderColumn = { key: 'usedBy', label: 'Used by' }
const REASON_COLUMN: TableHeaderColumn = { key: 'reason', label: 'Reason', width: '9rem' }
const ACTIONS_COLUMN: TableHeaderColumn = {
  key: 'actions',
  label: 'Actions',
  width: '15rem',
  align: 'right',
}
const COLUMNS: TableHeaderColumn[] = [PROVIDER_COLUMN, MODEL_COLUMN, ACTIONS_COLUMN]
const REFERENCED_COLUMNS: TableHeaderColumn[] = [
  PROVIDER_COLUMN,
  MODEL_COLUMN,
  USED_BY_COLUMN,
  ACTIONS_COLUMN,
]
const REVIEWED_COLUMNS: TableHeaderColumn[] = [
  PROVIDER_COLUMN,
  MODEL_COLUMN,
  REASON_COLUMN,
  USED_BY_COLUMN,
  ACTIONS_COLUMN,
]

const REASON_LABELS: Record<string, string> = {
  stale_model_referenced: 'No longer listed',
  deprecated_model_enabled: 'Deprecated',
}

function plural(count: number): string {
  return count === 1 ? '' : 's'
}

function isAre(count: number): string {
  return count === 1 ? 'is' : 'are'
}

function itOrEach(count: number): string {
  return count === 1 ? 'it' : 'each one'
}

/** `Label (Provider · model-id)`: names the row an action button acts on. */
function itemAccessibleName(item: AdminAttentionItem): string {
  return `${item.displayName ?? item.model} (${getProviderDisplayLabel(item.provider)} · ${item.model})`
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

function ProviderCell({ provider }: AttentionProviderCellProps) {
  const label = getProviderDisplayLabel(provider)
  return (
    <td>
      <span className="cu-llm-auto-enable__provider">
        <LlmProviderIcon provider={provider} label={label} />
        <span>{label}</span>
      </span>
    </td>
  )
}

function ModelCell({ item }: AttentionModelCellProps) {
  return (
    <td>
      {item.displayName ?? item.model}
      {item.displayName && item.displayName !== item.model ? (
        <div className="cu-llm-auto-enable__hint">{item.model}</div>
      ) : null}
    </td>
  )
}

function UsedByCell({ item }: AttentionUsedByCellProps) {
  return (
    <td>
      <ModelReferences
        hostsAffected={item.hostsAffected}
        grantsAffected={item.grantsAffected}
        recipesAffected={item.recipesAffected}
      />
    </td>
  )
}

/**
 * Review link plus the in-dialog decisions. `Keep enabled` (stale items only)
 * pins the model on and then marks the item reviewed; `Reviewed` only marks it.
 * Both need an item the server can acknowledge; `Keep enabled` also needs the
 * model's allowlist row to address the PUT.
 */
function AttentionItemActions({
  item,
  modelIdsByPair,
  busy,
  error,
  onKeepEnabled,
  onMarkReviewed,
}: AttentionItemActionsProps) {
  const ackable = isAckableAttentionItem(item) ? item : null
  const canKeepEnabled =
    ackable !== null &&
    ackable.kind === 'stale_model_referenced' &&
    modelIdsByPair.has(attentionPairKey(ackable))
  const name = itemAccessibleName(item)
  return (
    <td>
      <div className="cu-model-attention__actions">
        <AttentionReviewLink item={item} modelIdsByPair={modelIdsByPair} />
        {canKeepEnabled ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-label={`Keep enabled: ${name}`}
            onClick={() => onKeepEnabled(ackable)}
          >
            Keep enabled
          </Button>
        ) : null}
        {ackable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Mark reviewed: ${name}`}
            onClick={() => onMarkReviewed(ackable)}
          >
            Reviewed
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="cu-model-attention__error" role="alert">
          {error}
        </p>
      ) : null}
    </td>
  )
}

function ReviewedAttentionSection({
  items,
  busyKeys,
  itemErrors,
  onUndoReviewed,
}: ReviewedAttentionSectionProps) {
  if (items.length === 0) return null
  return (
    <details className="cu-advanced-details cu-model-attention__group cu-model-attention__reviewed">
      <summary>Reviewed ({items.length})</summary>
      <p className="cu-model-attention__lede">
        Models you already reviewed. They come back to review when they change or gain a new
        consumer.
      </p>
      <DataTable className="eft-table cu-table cu-table--header-band">
        <thead>
          <TableHeaderRow columns={REVIEWED_COLUMNS} />
        </thead>
        <tbody>
          {items.map(item => {
            const key = attentionItemKey(item)
            const error = itemErrors.get(key)
            return (
              <tr key={key} className="cu-table__row">
                <ProviderCell provider={item.provider} />
                <ModelCell item={item} />
                <td>{REASON_LABELS[item.kind] ?? item.kind}</td>
                <UsedByCell item={item} />
                <td>
                  <div className="cu-model-attention__actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyKeys.has(key)}
                      aria-label={`Undo review: ${itemAccessibleName(item)}`}
                      onClick={() => onUndoReviewed(item)}
                    >
                      Undo
                    </Button>
                  </div>
                  {error ? (
                    <p className="cu-model-attention__error" role="alert">
                      {error}
                    </p>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </DataTable>
    </details>
  )
}

function AttentionSection({ lede, columns, children }: AttentionSectionProps) {
  return (
    <div className="cu-model-attention__group">
      <p className="cu-model-attention__lede">{lede}</p>
      <DataTable className="eft-table cu-table cu-table--header-band">
        <thead>
          <TableHeaderRow columns={columns} />
        </thead>
        <tbody>{children}</tbody>
      </DataTable>
    </div>
  )
}

/**
 * The detail behind the one-line catalog attention banner: one table per group,
 * in the banner's order and the feed's row order, each row linking to the
 * model's edit page and offering the in-dialog decisions, then a collapsed
 * Reviewed section with what the operator already acknowledged.
 */
export function CatalogAttentionDialog({
  open,
  onDismiss,
  groups,
  reviewed,
  modelIdsByPair,
  busyKeys,
  itemErrors,
  onKeepEnabled,
  onMarkReviewed,
  onUndoReviewed,
}: CatalogAttentionDialogProps) {
  // Without it the dialog focuses the first `Review` link, and an Enter on open
  // would navigate away.
  const doneRef = useRef<HTMLButtonElement>(null)
  const { staleReferenced, deprecated, staleDiscovery } = groups

  function renderActions(item: AdminAttentionItem) {
    const key = attentionItemKey(item)
    return (
      <AttentionItemActions
        item={item}
        modelIdsByPair={modelIdsByPair}
        busy={busyKeys.has(key)}
        error={itemErrors.get(key)}
        onKeepEnabled={onKeepEnabled}
        onMarkReviewed={onMarkReviewed}
      />
    )
  }

  return (
    <DialogShell
      open={open}
      onDismiss={() => onDismiss()}
      title="Models that need review"
      size="large"
      initialFocusRef={doneRef}
      footer={
        <button
          ref={doneRef}
          type="button"
          className="cu-btn cu-btn--primary cu-btn--sm"
          onClick={() => onDismiss()}
        >
          Done
        </button>
      }
    >
      {staleReferenced.length > 0 ? (
        <AttentionSection
          columns={REFERENCED_COLUMNS}
          lede={
            <>
              <strong>{staleReferenced.length}</strong> model{plural(staleReferenced.length)}{' '}
              disappeared from the provider catalog but {isAre(staleReferenced.length)} still
              referenced. Disable {itOrEach(staleReferenced.length)} or update the references
              pointing at it.
            </>
          }
        >
          {staleReferenced.map(item => (
            <tr key={attentionItemKey(item)} className="cu-table__row">
              <ProviderCell provider={item.provider} />
              <ModelCell item={item} />
              <UsedByCell item={item} />
              {renderActions(item)}
            </tr>
          ))}
        </AttentionSection>
      ) : null}
      {deprecated.length > 0 ? (
        <AttentionSection
          columns={REFERENCED_COLUMNS}
          lede={
            <>
              <strong>{deprecated.length}</strong> enabled model{plural(deprecated.length)}{' '}
              {isAre(deprecated.length)} marked deprecated in the provider catalog. Review{' '}
              {itOrEach(deprecated.length)}: disable it, replace it with a newer model, or keep it
              enabled.
            </>
          }
        >
          {deprecated.map(item => (
            <tr key={attentionItemKey(item)} className="cu-table__row">
              <ProviderCell provider={item.provider} />
              <ModelCell item={item} />
              <UsedByCell item={item} />
              {renderActions(item)}
            </tr>
          ))}
        </AttentionSection>
      ) : null}
      {staleDiscovery.length > 0 ? (
        <AttentionSection
          columns={COLUMNS}
          lede={
            <>
              <strong>{staleDiscovery.length}</strong> enabled discovered model
              {plural(staleDiscovery.length)} {isAre(staleDiscovery.length)} no longer listed in the
              provider catalog. Review {itOrEach(staleDiscovery.length)}: disable it, replace it, or
              keep it if the provider still serves it.
            </>
          }
        >
          {staleDiscovery.map(item => (
            <tr key={attentionItemKey(item)} className="cu-table__row">
              <ProviderCell provider={item.provider} />
              <ModelCell item={item} />
              {renderActions(item)}
            </tr>
          ))}
        </AttentionSection>
      ) : null}
      <ReviewedAttentionSection
        items={reviewed}
        busyKeys={busyKeys}
        itemErrors={itemErrors}
        onUndoReviewed={onUndoReviewed}
      />
    </DialogShell>
  )
}
