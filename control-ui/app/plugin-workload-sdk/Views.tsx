'use client'

import React from 'react'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { IconX } from '@components/icons'
import { Button, SelectInput, TextInput } from '@components/ui'
import type {
  PluginWorkloadSdkFamily,
  PluginWorkloadSdkGrant,
  PluginWorkloadSdkInvocation,
  PluginWorkloadSdkLegacyGrantInventory,
} from '@lib/api'

const GRANT_COLUMNS: TableHeaderColumn[] = [
  { key: 'recipe', label: 'Recipe' },
  { key: 'family', label: 'Capability' },
  { key: 'allowlists', label: 'Allowlists' },
  { key: 'quota', label: 'Quota' },
  { key: 'actions', label: 'Actions', width: '8rem', align: 'right' },
]

const INVOCATION_COLUMNS: TableHeaderColumn[] = [
  { key: 'created', label: 'Created' },
  { key: 'recipe', label: 'Recipe' },
  { key: 'caller', label: 'Caller' },
  { key: 'method', label: 'Method' },
  { key: 'detail', label: 'Model / Event' },
  { key: 'status', label: 'Status' },
]

const METHOD_OPTIONS: PluginWorkloadSdkFamily[] = ['promptBridge', 'clientNotifications']
const STATUS_OPTIONS = [
  'in_progress',
  'complete',
  'failed',
  'provider_unavailable',
  'accepted',
  'delivered',
]

function statusBadgeClass(status: string): string {
  if (status === 'complete' || status === 'delivered' || status === 'accepted') {
    return 'cu-badge cu-badge--ok'
  }
  if (status === 'failed' || status === 'provider_unavailable') {
    return 'cu-badge cu-badge--error'
  }
  return 'cu-badge'
}

export function GrantsView({
  grants,
  loading,
  error,
  deletingId,
  userMap,
  legacyInventory,
  onEdit,
  onDelete,
}: {
  grants: PluginWorkloadSdkGrant[]
  loading: boolean
  error: string
  deletingId: string | null
  userMap: Map<string, string>
  legacyInventory: PluginWorkloadSdkLegacyGrantInventory | null
  onEdit: (grant: PluginWorkloadSdkGrant) => void
  onDelete: (grant: PluginWorkloadSdkGrant) => void
}) {
  if (error) {
    return (
      <div className="cu-card__body">
        <div className="cu-banner cu-banner--error">{error}</div>
      </div>
    )
  }
  if (grants.length === 0 && !loading && !legacyInventory?.legacyPromptBridgeGrants) {
    return (
      <div className="cu-card__body">
        <div className="cu-empty">
          No SDK grants yet. Click <strong>New grant</strong> to authorize a recipe capability.
        </div>
      </div>
    )
  }
  return (
    <>
      {legacyInventory && legacyInventory.legacyPromptBridgeGrants > 0 ? (
        <div className="cu-card__body">
          <div className="cu-banner cu-banner--error">
            {legacyInventory.legacyPromptBridgeGrants} promptBridge grant(s) require explicit
            operator review before activation. Open each row and save the ordered policy; no legacy
            policy is activated automatically.
          </div>
        </div>
      ) : null}
      <div className="cu-table-wrap">
        <table className="cu-table">
          <thead>
            <TableHeaderRow columns={GRANT_COLUMNS} />
          </thead>
          <tbody>
            {grants.map(grant => {
              const allowlist =
                grant.capabilityFamily === 'promptBridge'
                  ? (grant.promptTargets ?? []).map(
                      (target, index) =>
                        `${index === 0 ? 'default' : `fallback ${index}`}: ${target.provider}/${target.model} (${target.credentialSlot})`
                    )
                  : grant.allowedEventTypes
              const quotaParts: string[] = []
              if (grant.quotaLimits.maxRequestsPerRun)
                quotaParts.push(`${grant.quotaLimits.maxRequestsPerRun}/run`)
              if (grant.quotaLimits.maxNotificationsPerRun)
                quotaParts.push(`${grant.quotaLimits.maxNotificationsPerRun}/run`)
              if (grant.quotaLimits.maxInvocationsPerMinute)
                quotaParts.push(`${grant.quotaLimits.maxInvocationsPerMinute}/min`)
              if (grant.quotaLimits.maxNotificationsPerMinute)
                quotaParts.push(`${grant.quotaLimits.maxNotificationsPerMinute}/min`)
              const userRefsDisplay =
                grant.allowedUserRefs.length > 0
                  ? grant.allowedUserRefs.map(ref => userMap.get(ref) ?? ref).join(', ')
                  : null
              return (
                <tr key={grant.id} className="cu-table__row">
                  <td>
                    <span className="cu-link">{grant.recipeName}</span>
                    <span className="cu-field__hint"> ({grant.recipeNamespace})</span>
                  </td>
                  <td>
                    <span className="cu-badge">{grant.capabilityFamily}</span>
                    <span
                      className={
                        grant.policyState === 'active'
                          ? 'cu-badge cu-badge--ok'
                          : 'cu-badge cu-badge--error'
                      }
                    >
                      {grant.policyState === 'active'
                        ? 'Active'
                        : grant.policyState.replace('_', ' ')}
                    </span>
                  </td>
                  <td>
                    {allowlist.length === 0 ? '- (migration required)' : allowlist.join(', ')}
                    {userRefsDisplay ? (
                      <span className="cu-field__hint"> · users: {userRefsDisplay}</span>
                    ) : null}
                  </td>
                  <td>{quotaParts.length === 0 ? '-' : quotaParts.join(', ')}</td>
                  <td className="cu-cell--right">
                    <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(grant)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      className="cu-btn--icon cu-btn--danger-icon"
                      onClick={() => onDelete(grant)}
                      disabled={deletingId === grant.id}
                      aria-label={`Delete grant for ${grant.recipeName}`}
                    >
                      <IconX width={16} height={16} />
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function InvocationsView({
  invocations,
  loading,
  error,
  filterRecipe,
  filterMethod,
  filterStatus,
  onFilterRecipe,
  onFilterMethod,
  onFilterStatus,
  onApply,
}: {
  invocations: PluginWorkloadSdkInvocation[]
  loading: boolean
  error: string
  filterRecipe: string
  filterMethod: string
  filterStatus: string
  onFilterRecipe: (v: string) => void
  onFilterMethod: (v: string) => void
  onFilterStatus: (v: string) => void
  onApply: () => void
}) {
  return (
    <>
      <div className="cu-card__body cu-filter-row">
        <TextInput
          compact
          narrow
          placeholder="Recipe name"
          value={filterRecipe}
          onChange={e => onFilterRecipe(e.target.value)}
          aria-label="Filter by recipe name"
        />
        <SelectInput
          compact
          narrow
          value={filterMethod}
          onChange={e => onFilterMethod(e.target.value)}
          aria-label="Filter by method"
        >
          <option value="">All methods</option>
          {METHOD_OPTIONS.map(m => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          compact
          narrow
          value={filterStatus}
          onChange={e => onFilterStatus(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </SelectInput>
        <Button variant="secondary" size="sm" onClick={onApply} disabled={loading}>
          Apply
        </Button>
      </div>

      {error ? (
        <div className="cu-card__body">
          <div className="cu-banner cu-banner--error">{error}</div>
        </div>
      ) : null}

      {invocations.length === 0 && !loading ? (
        <div className="cu-card__body">
          <div className="cu-empty">No invocations match these filters.</div>
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table">
            <thead>
              <TableHeaderRow columns={INVOCATION_COLUMNS} />
            </thead>
            <tbody>
              {invocations.map(inv => (
                <tr key={inv.id} className="cu-table__row">
                  <td>{new Date(inv.createdAt).toLocaleString()}</td>
                  <td>
                    <span className="cu-link">{inv.recipeName}</span>
                    <span className="cu-field__hint"> ({inv.recipeNamespace})</span>
                  </td>
                  <td>{inv.callerRef}</td>
                  <td>
                    <span className="cu-badge">{inv.method}</span>
                  </td>
                  <td>{inv.detail}</td>
                  <td>
                    <span className={statusBadgeClass(inv.status)}>{inv.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
