'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DataTable, TableRow, TableStateRow, TruncatedText } from '@clerum/frontend-components'
import { FilterSelect } from '@components/FilterSelect'
import { MarketplaceTabs } from '@components/MarketplaceTabs'
import { type RowActionMenuItem, RowActionsMenu } from '@components/RowActionsMenu'
import { SectionSearchInput } from '@components/SectionSearchInput'
import { IconStore } from '@components/Sidebar/icons'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import { type RegistryEntry, deleteRegistryEntry, getRegistryCatalog } from '../lib/api'
import { useRegistryCapability } from '../lib/hooks/useRegistryCapability'

type CatalogSortKey = 'name' | 'description' | 'quality'
type SortDirection = 'asc' | 'desc'

const REGISTRY_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name', width: '24%' },
  { key: 'description', label: 'Description' },
  { key: 'quality', label: 'Verification', width: '9rem' },
  { key: 'actions', align: 'right', ariaLabel: 'Actions', width: '3.5rem' },
]

export default function RegistryCatalog() {
  const router = useRouter()
  const { showToast } = useToast()
  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [installedCatalogKeys, setInstalledCatalogKeys] = useState<Set<string>>(new Set())
  const [installedServerNames, setInstalledServerNames] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [sortKey, setSortKey] = useState<CatalogSortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [removeTarget, setRemoveTarget] = useState<RegistryEntry | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  // Capability + connection signals for rendering only controls this deployment
  // can actually use (design spec §5.1). The hook composes publish-scope
  // (identity / curator) with the connect probe (mode / state), so the catalog
  // no longer fetches the connection separately. Fail-open: while unresolved,
  // mode is 'unknown' so the connect entry point isn't hidden.
  const { capability } = useRegistryCapability()
  const isCurator = capability?.isCurator === true
  const orgScope = capability?.scope ?? null
  const connectionMode = capability?.mode ?? 'unknown'
  const connectionState = capability?.connectionState ?? null
  // Curators administer the shared catalog, so they keep inline edit/remove;
  // everyone else manages their own entries from the ownership area (§5.4).
  const columns: TableHeaderColumn[] = REGISTRY_COLUMNS.map(column => {
    if (column.key === 'name' || column.key === 'description' || column.key === 'quality') {
      return {
        ...column,
        activeDirection: sortKey === column.key ? sortDirection : null,
        onSort: () => toggleSort(column.key as CatalogSortKey),
      }
    }
    return column
  })

  useEffect(() => {
    void loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const catalog = await getRegistryCatalog({ limit: '200' })
      setEntries(catalog.data)
      setCategories(
        Array.from(
          new Set(
            catalog.data
              .filter(entry => entry.entry_type === 'mcp-server')
              .map(entry => entry.category)
          )
        ).sort((left, right) => left.localeCompare(right))
      )
      setInstalledCatalogKeys(new Set(catalog.installed.catalogKeys))
      setInstalledServerNames(new Set(catalog.installed.serverNames))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmRemove() {
    if (!removeTarget || removing) return
    const target = removeTarget
    setRemoving(true)
    setRemoveError('')
    try {
      await deleteRegistryEntry(target.name, target.version)
      showToast(`Removed ${target.name} v${target.version} from the Marketplace.`, {
        tone: 'success',
      })
      setRemoveTarget(null)
      await loadData()
    } catch (removeFailure) {
      setRemoveError(
        removeFailure instanceof Error ? removeFailure.message : 'Failed to remove from Marketplace'
      )
    } finally {
      setRemoving(false)
    }
  }

  const connectorEntries = useMemo(
    () => entries.filter(entry => entry.entry_type === 'mcp-server'),
    [entries]
  )
  const filtered = useMemo(() => {
    const visibleEntries = connectorEntries.filter(entry => {
      if (entry.visibility === 'private') return false
      if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false
      if (!search) return true
      const query = search.toLowerCase()
      return (
        entry.name.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query) ||
        entry.tags.some(tag => tag.toLowerCase().includes(query))
      )
    })
    const direction = sortDirection === 'asc' ? 1 : -1
    return [...visibleEntries].sort((left, right) => {
      const comparison =
        sortKey === 'description'
          ? left.description.localeCompare(right.description, undefined, { sensitivity: 'base' })
          : sortKey === 'quality'
            ? left.quality_tier.localeCompare(right.quality_tier)
            : left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      if (comparison !== 0) return comparison * direction
      return `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
    })
  }, [categoryFilter, connectorEntries, search, sortDirection, sortKey])

  const isInitialLoad = loading && entries.length === 0

  function toggleSort(key: CatalogSortKey) {
    if (sortKey === key) {
      setSortDirection(direction => (direction === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDirection('asc')
  }

  function isEntryInstalled(entry: RegistryEntry): boolean {
    return (
      installedCatalogKeys.has(`${entry.name}@${entry.version}`) ||
      installedServerNames.has(entry.name)
    )
  }

  // An entry belongs to this deployment's org when its name carries the org
  // scope prefix (publishes are stored as `@org/name`, see applyPublishScope).
  function isOwnedEntry(entry: RegistryEntry): boolean {
    return !!orgScope && entry.name.startsWith(`${orgScope}/`)
  }

  const showConnectBanner =
    connectionMode === 'self-hosted' &&
    (connectionState === 'disconnected' || connectionState === 'rejected')
  // Keep the connect prompt visible even when the catalog request fails.
  const connectBanner = showConnectBanner ? (
    <div className="cu-banner cu-banner--info" role="status">
      <span>
        This deployment isn&apos;t connected to a registry. Connect it to publish and install
        connectors.
      </span>
      <button
        type="button"
        className="cu-btn cu-btn--primary cu-btn--sm"
        onClick={() => router.push(CONTROL_ROUTES.marketplace.connect)}
      >
        Connect to registry
      </button>
    </div>
  ) : null

  return (
    <div className="cu-registry-layout">
      {connectBanner}
      <div className="cu-card cu-card--viewport-fill cu-section-card">
        <TablePanelHeader
          title={
            <>
              <IconStore />
              Marketplace
            </>
          }
          subtitle="Discover and install connectors from the Marketplace."
          actionsClassName="cu-registry-toolbar"
          secondaryActions={
            <>
              <div className="cu-registry-filter-group">
                <FilterSelect
                  value={categoryFilter}
                  onChange={setCategoryFilter}
                  options={[
                    { value: 'all', label: 'All Categories' },
                    ...categories.map(category => ({ value: category, label: category })),
                  ]}
                  disabled={isInitialLoad}
                  ariaLabel="Filter by category"
                />
              </div>
              {connectionMode !== 'managed' && connectionState !== 'connected' ? (
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  onClick={() => router.push(CONTROL_ROUTES.marketplace.connect)}
                  disabled={isInitialLoad}
                >
                  Connect
                </button>
              ) : null}
              {/* Publish-to-Marketplace hidden for now under the distribution
                  strategy narrowing. Commented out — restore when public/org
                  connector publishing returns to discovery.
              {canManageOrg || isCurator ? (
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() =>
                    router.push(CONTROL_ROUTES.marketplace.publish({ type: 'mcp-server' }))
                  }
                  disabled={isInitialLoad}
                >
                  + Publish to Marketplace
                </button>
              ) : null}
              */}
            </>
          }
          search={
            <SectionSearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search connectors..."
              ariaLabel="Search the Marketplace"
              disabled={isInitialLoad}
            />
          }
        />
        <MarketplaceTabs active="connectors" />
        {error ? <div className="cu-banner cu-banner--error">Error: {error}</div> : null}
        <div className="eft-table-viewport cu-table-wrap cu-marketplace-table-wrap">
          <DataTable className="eft-table cu-table cu-table--header-band cu-marketplace-table">
            <thead>
              <TableHeaderRow columns={columns} />
            </thead>
            <tbody>
              {isInitialLoad ? (
                <TableStateRow
                  colSpan={columns.length}
                  kind="loading"
                  message="Loading Marketplace connectors…"
                />
              ) : error ? (
                <TableStateRow colSpan={columns.length} kind="error" message={error} />
              ) : filtered.length === 0 ? (
                <TableStateRow
                  colSpan={columns.length}
                  message="No connectors match your filters."
                />
              ) : (
                filtered.map(entry => {
                  const detailRoute = CONTROL_ROUTES.marketplace.entry(entry.name, entry.version)
                  const installed = isEntryInstalled(entry)
                  return (
                    <TableRow
                      className="cu-table__row cu-table__row--clickable"
                      key={entry.id}
                      onNavigate={() => router.push(detailRoute)}
                    >
                      <td>
                        <span className="cu-registry-name">{entry.name}</span>
                        {!isCurator && isOwnedEntry(entry) ? (
                          <div className="cu-registry-owned">Owned by your organization</div>
                        ) : null}
                      </td>
                      <td>
                        <TruncatedText value={entry.description} />
                      </td>
                      <td>
                        <span
                          className={`cu-registry-chip cu-registry-chip--quality-${entry.quality_tier}`}
                        >
                          {entry.quality_tier}
                        </span>
                      </td>
                      <td
                        className="cu-table__cell-actions"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={event => event.stopPropagation()}
                      >
                        <RowActionsMenu
                          ariaLabel={`Actions for ${entry.name} v${entry.version}`}
                          actions={
                            [
                              {
                                key: 'view',
                                label: 'View details',
                                onClick: () => router.push(detailRoute),
                              },
                              ...(!isCurator && isOwnedEntry(entry)
                                ? [
                                    {
                                      key: 'manage-owned',
                                      label: 'Manage published entry',
                                      onClick: () =>
                                        router.push(CONTROL_ROUTES.marketplace.orgEntries),
                                    },
                                  ]
                                : []),
                              ...(installed
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
                                            entry: entry.name,
                                            version: entry.version,
                                          })
                                        ),
                                    },
                                  ]),
                              ...(isCurator
                                ? [
                                    {
                                      key: 'edit',
                                      label: 'Edit',
                                      onClick: () =>
                                        router.push(
                                          CONTROL_ROUTES.marketplace.editEntry(
                                            entry.name,
                                            entry.version
                                          )
                                        ),
                                    },
                                    {
                                      key: 'remove',
                                      label: 'Remove from Marketplace',
                                      danger: true,
                                      onClick: () => {
                                        setRemoveError('')
                                        setRemoveTarget(entry)
                                      },
                                    },
                                  ]
                                : []),
                            ] satisfies RowActionMenuItem[]
                          }
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
      {removeTarget ? (
        <div
          role="presentation"
          className="cu-modal-backdrop"
          onClick={event => {
            if (event.target === event.currentTarget && !removing) setRemoveTarget(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="registry-remove-modal-title"
            className="cu-modal-panel"
            onClick={event => event.stopPropagation()}
          >
            <h3 id="registry-remove-modal-title">Remove from Marketplace</h3>
            <p>
              Remove <strong>{removeTarget.name}</strong> v{removeTarget.version} from the
              Marketplace. Already-installed copies stay running.
            </p>
            {removeError ? (
              <div className="cu-banner cu-banner--error" role="alert">
                {removeError}
              </div>
            ) : null}
            <div className="cu-create-actions">
              <button
                type="button"
                className="cu-btn cu-btn--ghost"
                onClick={() => setRemoveTarget(null)}
                disabled={removing}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--danger"
                onClick={handleConfirmRemove}
                disabled={removing}
              >
                {removing ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
