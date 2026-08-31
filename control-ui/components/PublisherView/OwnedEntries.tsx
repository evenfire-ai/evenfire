'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { DataTable, TableRow, TableStateRow, useTableSort } from '@clerum/frontend-table-system'
import { MARKETPLACE_ENTRY_TYPE_LABELS } from '@constants/marketplaceEntryTypes'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type OwnedRegistryEntry,
  deleteRegistryEntry,
  getOwnedRegistryEntries,
  getRegistryCatalog,
} from '../../lib/api'
import { useConfirmDialog } from '../ConfirmDialog'
import { type RowActionMenuItem, RowActionsMenu } from '../RowActionsMenu'
import { TableHeaderRow } from '../TableHeaderRow'
import type { TableHeaderColumn } from '../TableHeaderRow/types'
import { TablePanelHeader } from '../TablePanelHeader'
import { useToast } from '../Toast'
import { GrantAccessModal } from './GrantAccessModal'

type GrantTarget = {
  entryName: string
  opener: HTMLButtonElement
}

const COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'version', label: 'Version' },
  { key: 'visibility', label: 'Visibility' },
  { key: 'status', label: 'Status' },
  { key: 'actions', ariaLabel: 'Actions', align: 'right' },
]

function entryKey(e: OwnedRegistryEntry): string {
  return `${e.name}@${e.version}`
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const left = Number.parseInt(pa[index] ?? '0', 10)
    const right = Number.parseInt(pb[index] ?? '0', 10)
    if (Number.isNaN(left) || Number.isNaN(right)) return b.localeCompare(a)
    if (left !== right) return right - left
  }
  return b.localeCompare(a)
}

// The registry's owned-entries payload carries `serverMode` but not `entry_type`
// (mcp-servers always have a serverMode; recipes don't). Prefer an explicit
// entry_type if the registry ever starts sending it, else infer from serverMode.
// "Connector" / "Plugin" mirror the labels in PublishToRegistryForm.
function ownedEntryKind(e: OwnedRegistryEntry): string {
  // Wire field is `entryType` (camelCase); `entry_type` kept as a fallback.
  return e.entryType ?? e.entry_type ?? (e.serverMode != null ? 'mcp-server' : 'recipe')
}

function entryTypeLabel(e: OwnedRegistryEntry): string {
  const kind = ownedEntryKind(e)
  if (kind === 'mcp-server') return 'Connector'
  if (kind === 'llm-hook') return 'Guardrail hook'
  return 'Plugin'
}

/**
 * The org's own published entries — the home for the edit/remove that discovery
 * surfaces no longer offer (design spec §5.4). Sharing is capability-gated:
 *
 * - `canShare` (the deployment holds `registry:grant`) → offer the Share control.
 * - `sharingUnavailable` (a self-hosted org can never share cross-org) → state
 *   the limit once rather than offering a control that would be refused (§1.2).
 *
 * Both derive from the parent's inbound-grants probe, so no extra fetch is made.
 */
export function OwnedEntries({
  orgScope,
  canShare = true,
  sharingUnavailable = false,
}: {
  orgScope: string
  canShare?: boolean
  sharingUnavailable?: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [entries, setEntries] = useState<OwnedRegistryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [grantTarget, setGrantTarget] = useState<GrantTarget | null>(null)
  // Installed cluster resources (same source the catalog uses to show
  // "Installed"). Best-effort: a catalog fetch failure just means no entry is
  // marked installed, never an error on the entries list.
  const [installedCatalogKeys, setInstalledCatalogKeys] = useState<Set<string>>(new Set())
  const [installedServerNames, setInstalledServerNames] = useState<Set<string>>(new Set())
  const [installedRecipeKeys, setInstalledRecipeKeys] = useState<Set<string>>(new Set())
  const [installedHookKeys, setInstalledHookKeys] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const [{ data }, catalog] = await Promise.all([
        getOwnedRegistryEntries(),
        getRegistryCatalog({ limit: '500' }).catch(() => null),
      ])
      setEntries(data)
      if (catalog) {
        setInstalledCatalogKeys(new Set(catalog.installed.catalogKeys))
        setInstalledServerNames(new Set(catalog.installed.serverNames))
        setInstalledRecipeKeys(new Set(catalog.installed.recipeKeys))
        setInstalledHookKeys(new Set(catalog.installed.hookKeys ?? []))
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleRemove = useCallback(
    async (e: OwnedRegistryEntry) => {
      const ok = await confirm({
        title: 'Remove from Marketplace',
        message: `Remove ${e.name} v${e.version} from the Marketplace? Already-installed copies stay running. This cannot be undone.`,
        confirmLabel: 'Remove',
        tone: 'danger',
      })
      if (!ok) return
      try {
        await deleteRegistryEntry(e.name, e.version)
        showToast(`Removed ${e.name} v${e.version} from the Marketplace.`, { tone: 'success' })
        await load()
      } catch {
        showToast(`Could not remove ${e.name}.`, { tone: 'error' })
      }
    },
    [confirm, showToast, load]
  )

  function isInstalled(e: OwnedRegistryEntry): boolean {
    const kind = ownedEntryKind(e)
    const key = `${e.name}@${e.version}`
    if (kind === 'mcp-server') {
      return installedCatalogKeys.has(key) || installedServerNames.has(e.name)
    }
    if (kind === 'llm-hook') return installedHookKeys.has(key)
    return installedRecipeKeys.has(key)
  }

  // `?type=` narrows the list to a single entry kind — this is how "Add hook"
  // on an agent lands here showing only guardrail hooks. An unrecognised value
  // filters nothing, so a stale or hand-edited link degrades to the full list
  // instead of an empty one.
  const typeFilter = searchParams?.get('type') ?? null
  const activeTypeLabel = typeFilter ? MARKETPLACE_ENTRY_TYPE_LABELS[typeFilter] : undefined
  const visibleEntries = useMemo(
    () => (activeTypeLabel ? entries.filter(e => ownedEntryKind(e) === typeFilter) : entries),
    [entries, typeFilter, activeTypeLabel]
  )

  // Deliberately org-wide, not `visibleEntries`: the notice describes what
  // cross-org sharing does to this org's private entries, so a `?type=` filter
  // that happens to hide them all must not make it disappear.
  const hasPrivateEntries = entries.some(e => e.visibility === 'private')
  const entrySort = useTableSort<
    OwnedRegistryEntry,
    'name' | 'type' | 'version' | 'visibility' | 'status'
  >({
    rows: visibleEntries,
    defaultKey: 'name',
    identity: entryKey,
    accessors: {
      name: entry => entry.name,
      type: entry => entryTypeLabel(entry),
      version: entry => entry.version,
      visibility: entry => entry.visibility,
      status: entry => entry.status,
    },
  })
  const columns = COLUMNS.map(column =>
    column.key === 'actions'
      ? column
      : {
          ...column,
          activeDirection: entrySort.key === column.key ? entrySort.direction : null,
          onSort: () =>
            entrySort.sortBy(column.key as 'name' | 'type' | 'version' | 'visibility' | 'status'),
        }
  )
  const sortedEntries = useMemo(() => {
    if (entrySort.key !== 'name') return entrySort.sortedRows
    const direction = entrySort.direction === 'asc' ? 1 : -1
    return [...entrySort.sortedRows].sort((left, right) => {
      const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      return byName === 0 ? compareVersionDesc(left.version, right.version) : byName * direction
    })
  }, [entrySort.direction, entrySort.key, entrySort.sortedRows])

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title="Published entries"
          subtitle={
            sharingUnavailable && hasPrivateEntries
              ? 'Cross-org sharing isn’t available on this deployment, so private entries stay visible only to your org.'
              : undefined
          }
        />
        <div className="cu-card__body">
          {!loading && !error && activeTypeLabel ? (
            <p className="cu-banner cu-banner--info">
              Showing {activeTypeLabel.toLowerCase()} only.{' '}
              <button
                type="button"
                className="cu-link"
                onClick={() => router.replace(CONTROL_ROUTES.marketplace.orgEntries)}
              >
                Show all entries
              </button>
            </p>
          ) : null}
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table">
              <thead>
                <TableHeaderRow columns={columns} />
              </thead>
              <tbody>
                {loading ? (
                  <TableStateRow
                    colSpan={columns.length}
                    kind="loading"
                    message="Loading published entries…"
                  />
                ) : error ? (
                  <TableStateRow
                    action={
                      <button
                        type="button"
                        className="cu-btn cu-btn--ghost cu-btn--sm"
                        onClick={() => void load()}
                      >
                        Retry
                      </button>
                    }
                    colSpan={columns.length}
                    kind="error"
                    message="Could not load your published entries."
                  />
                ) : visibleEntries.length === 0 ? (
                  <TableStateRow
                    colSpan={columns.length}
                    message={
                      entries.length === 0
                        ? 'You haven’t published any registry entries yet.'
                        : `No ${activeTypeLabel?.toLowerCase() ?? 'entries'} published yet.`
                    }
                  />
                ) : (
                  sortedEntries.map(e => {
                    const isPrivate = e.visibility === 'private'
                    const detailRoute = CONTROL_ROUTES.marketplace.entry(e.name, e.version)
                    const rowActions: RowActionMenuItem[] = [
                      {
                        key: 'view',
                        label: 'View details',
                        onClick: () => router.push(detailRoute),
                      },
                      ...(isInstalled(e)
                        ? [
                            {
                              key: 'installed',
                              label: 'Installed',
                              disabled: true,
                              onClick: () => undefined,
                            },
                          ]
                        : [
                            {
                              key: 'install',
                              label: 'Install',
                              onClick: () =>
                                router.push(
                                  CONTROL_ROUTES.marketplace.install({
                                    entry: e.name,
                                    version: e.version,
                                  })
                                ),
                            },
                          ]),
                      ...(isPrivate && canShare
                        ? [
                            {
                              key: 'share',
                              label: 'Share access',
                              onClick: () =>
                                setGrantTarget({
                                  entryName: e.name,
                                  opener: document.activeElement as HTMLButtonElement,
                                }),
                            },
                          ]
                        : []),
                      {
                        key: 'edit',
                        label: 'Edit',
                        onClick: () =>
                          router.push(CONTROL_ROUTES.marketplace.editEntry(e.name, e.version)),
                      },
                      {
                        key: 'remove',
                        label: 'Remove from Marketplace',
                        danger: true,
                        onClick: () => void handleRemove(e),
                      },
                    ]
                    return (
                      <TableRow key={entryKey(e)} onNavigate={() => router.push(detailRoute)}>
                        <td>
                          <code>{e.name}</code>
                        </td>
                        <td>{entryTypeLabel(e)}</td>
                        <td>{e.version}</td>
                        <td>
                          <span
                            className={`cu-registry-chip cu-registry-chip--visibility-${e.visibility}`}
                          >
                            {e.visibility}
                          </span>
                        </td>
                        <td>{e.status}</td>
                        <td className="cu-table__cell-actions">
                          <RowActionsMenu
                            ariaLabel={`Actions for ${e.name} v${e.version}`}
                            actions={rowActions}
                          />
                        </td>
                      </TableRow>
                    )
                  })
                )}
              </tbody>
            </DataTable>
          </div>
        </div>
      </div>
      {grantTarget ? (
        <GrantAccessModal
          entryName={grantTarget.entryName}
          orgScope={orgScope}
          opener={grantTarget.opener}
          onClose={() => setGrantTarget(null)}
        />
      ) : null}
      {confirmDialog}
    </section>
  )
}
