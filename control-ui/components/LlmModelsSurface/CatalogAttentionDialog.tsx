'use client'

import React, { useRef } from 'react'
import Link from 'next/link'
import { DataTable, DialogShell } from '@clerum/frontend-components'
import { LlmProviderIcon } from '@components/LlmProviderIcon'
import { ModelReferences } from '@components/ModelReferences'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { CONTROL_ROUTES } from '@constants/routes'
import type { AdminAttentionItem } from '@lib/api'
import { getProviderDisplayLabel } from '@lib/llm'
import { attentionPairKey } from '@lib/llmModelAttention'
import type {
  AttentionModelCellProps,
  AttentionProviderCellProps,
  AttentionReviewLinkProps,
  AttentionSectionProps,
  CatalogAttentionDialogProps,
} from './types'

// Fixed widths on the outer columns keep Provider aligned across the three
// tables: `.eft-table` lays out automatically and only the referenced group has
// the extra `Used by` column, so a minWidth would let each table drift.
const PROVIDER_COLUMN: TableHeaderColumn = { key: 'provider', label: 'Provider', width: '12rem' }
const MODEL_COLUMN: TableHeaderColumn = { key: 'model', label: 'Model' }
const USED_BY_COLUMN: TableHeaderColumn = { key: 'usedBy', label: 'Used by' }
const ACTIONS_COLUMN: TableHeaderColumn = {
  key: 'actions',
  label: 'Actions',
  width: '7rem',
  align: 'right',
}
const COLUMNS: TableHeaderColumn[] = [PROVIDER_COLUMN, MODEL_COLUMN, ACTIONS_COLUMN]
const REFERENCED_COLUMNS: TableHeaderColumn[] = [
  PROVIDER_COLUMN,
  MODEL_COLUMN,
  USED_BY_COLUMN,
  ACTIONS_COLUMN,
]

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

function rowKey(item: AdminAttentionItem): string {
  return `${item.kind}/${item.provider}/${item.model}`
}

/**
 * The detail behind the one-line catalog attention banner: one table per group,
 * in the banner's order and the feed's row order, each row linking to the
 * model's edit page.
 */
export function CatalogAttentionDialog({
  open,
  onDismiss,
  groups,
  modelIdsByPair,
}: CatalogAttentionDialogProps) {
  // Without it the dialog focuses the first `Review` link, and an Enter on open
  // would navigate away.
  const doneRef = useRef<HTMLButtonElement>(null)
  const { staleReferenced, deprecated, staleDiscovery } = groups

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
            <tr key={rowKey(item)} className="cu-table__row">
              <ProviderCell provider={item.provider} />
              <ModelCell item={item} />
              <td>
                <ModelReferences
                  hostsAffected={item.hostsAffected}
                  grantsAffected={item.grantsAffected}
                />
              </td>
              <td className="cu-px-actions">
                <AttentionReviewLink item={item} modelIdsByPair={modelIdsByPair} />
              </td>
            </tr>
          ))}
        </AttentionSection>
      ) : null}
      {deprecated.length > 0 ? (
        <AttentionSection
          columns={COLUMNS}
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
            <tr key={rowKey(item)} className="cu-table__row">
              <ProviderCell provider={item.provider} />
              <ModelCell item={item} />
              <td className="cu-px-actions">
                <AttentionReviewLink item={item} modelIdsByPair={modelIdsByPair} />
              </td>
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
            <tr key={rowKey(item)} className="cu-table__row">
              <ProviderCell provider={item.provider} />
              <ModelCell item={item} />
              <td className="cu-px-actions">
                <AttentionReviewLink item={item} modelIdsByPair={modelIdsByPair} />
              </td>
            </tr>
          ))}
        </AttentionSection>
      ) : null}
    </DialogShell>
  )
}
