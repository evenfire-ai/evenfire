'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { SectionSearchInput } from '@components/SectionSearchInput'
import { IconStore } from '@components/Sidebar/icons'
import { SkeletonTableRows } from '@components/SkeletonTableRows'
import { TabBar } from '@components/TabBar'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { IconChevronRight, IconPencil, IconX } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type RegistryConnectionState,
  type RegistryEntry,
  deleteRegistryEntry,
  getRegistryCatalog,
  getRegistryConnection,
  installRecipeFromRegistry,
} from '../lib/api'
import { trustBgColor, trustColor } from '../lib/trustLevel'

type MarketplaceTab = 'connectors' | 'plugins'

const MODE_FILTER_OPTIONS = [
  { value: 'all', label: 'All Modes' },
  { value: 'local', label: 'Local' },
  { value: 'remote', label: 'Remote' },
  { value: 'workflow', label: 'Workflow' },
  { value: 'only-workloads', label: 'Only Workloads' },
]

const REGISTRY_COLUMNS: TableHeaderColumn[] = [
  { key: 'expand', ariaLabel: 'Expand Marketplace entry' },
  { key: 'name', label: 'Name' },
  { key: 'version', label: 'Version' },
  { key: 'visibility', label: 'Visibility' },
  { key: 'downloads', label: 'Downloads' },
  { key: 'install', align: 'right', ariaLabel: 'Installation' },
  { key: 'actions', align: 'right', ariaLabel: 'Edit or remove' },
]

export default function RegistryCatalog() {
  const pathname = usePathname()
  const router = useRouter()
  const { showToast } = useToast()
  const activeTab: MarketplaceTab =
    pathname === CONTROL_ROUTES.marketplace.plugins ? 'plugins' : 'connectors'
  const activeEntryType = activeTab === 'plugins' ? 'recipe' : 'mcp-server'
  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [installedCatalogKeys, setInstalledCatalogKeys] = useState<Set<string>>(new Set())
  const [installedServerNames, setInstalledServerNames] = useState<Set<string>>(new Set())
  const [installedRecipeKeys, setInstalledRecipeKeys] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installingRecipeKey, setInstallingRecipeKey] = useState('')
  const [installError, setInstallError] = useState('')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [modeFilter, setModeFilter] = useState('all')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [removeTarget, setRemoveTarget] = useState<RegistryEntry | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  // Registry-connect discoverability: an independent, best-effort fetch that
  // derives whether this deployment is self-hosted and (if so) its connection
  // state, so the Marketplace can surface a "Connect" entry point. Initial mode
  // is 'unknown' (fail-open) so the entry point isn't hidden while the request
  // is in flight or if it errors for a reason other than a managed deployment.
  const [connectionMode, setConnectionMode] = useState<'self-hosted' | 'managed' | 'unknown'>(
    'unknown'
  )
  const [connectionState, setConnectionState] = useState<RegistryConnectionState | null>(null)

  useEffect(() => {
    void loadData()
    void loadConnectionMode()
  }, [])

  async function loadConnectionMode() {
    // Independent of the catalog browse: a browse failure must not hide the
    // connect entry point. Fail-open — any non-managed outcome keeps it visible.
    try {
      const status = await getRegistryConnection()
      setConnectionMode('self-hosted')
      setConnectionState(status.state)
    } catch (err) {
      setConnectionMode(
        (err as { code?: unknown }).code === 'not_self_hosted' ? 'managed' : 'unknown'
      )
      setConnectionState(null)
    }
  }

  async function loadData() {
    setLoading(true)
    setError(null)
    setInstallError('')
    try {
      const catalog = await getRegistryCatalog({ limit: '200' })
      setEntries(catalog.data)
      setCategories(catalog.categories)
      setInstalledCatalogKeys(new Set(catalog.installed.catalogKeys))
      setInstalledServerNames(new Set(catalog.installed.serverNames))
      setInstalledRecipeKeys(new Set(catalog.installed.recipeKeys))
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

  async function handleInstallRecipe(entry: RegistryEntry) {
    if (entry.entry_type !== 'recipe' || !entry.recipe_meta?.recipeYaml) return
    const key = `${entry.name}@${entry.version}`
    setInstallingRecipeKey(key)
    setInstallError('')
    try {
      await installRecipeFromRegistry({
        registryEntryName: entry.name,
        registryEntryVersion: entry.version,
        recipeManifest: entry.recipe_meta.recipeYaml,
      })
      setInstalledRecipeKeys(current => new Set(current).add(key))
      showToast(`Installed ${entry.name} v${entry.version}.`, { tone: 'success' })
    } catch (installFailure) {
      setInstallError(
        installFailure instanceof Error ? installFailure.message : 'Failed to install plugin'
      )
    } finally {
      setInstallingRecipeKey('')
    }
  }

  const tabEntries = useMemo(
    () => entries.filter(entry => entry.entry_type === activeEntryType),
    [activeEntryType, entries]
  )
  const filtered = useMemo(() => {
    return tabEntries.filter(entry => {
      if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false
      if (modeFilter !== 'all') {
        if (modeFilter === 'local' && entry.server_mode !== 'local') return false
        if (modeFilter === 'remote' && entry.server_mode !== 'remote') return false
        if (modeFilter === 'workflow' && entry.recipe_type !== 'workflow') return false
        if (modeFilter === 'only-workloads' && entry.recipe_type !== 'only-workloads') return false
      }
      if (!search) return true
      const query = search.toLowerCase()
      return (
        entry.name.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query) ||
        entry.tags.some(tag => tag.toLowerCase().includes(query))
      )
    })
  }, [categoryFilter, modeFilter, search, tabEntries])

  const isInitialLoad = loading && entries.length === 0

  function isEntryInstalled(entry: RegistryEntry): boolean {
    if (entry.entry_type === 'mcp-server') {
      return (
        installedCatalogKeys.has(`${entry.name}@${entry.version}`) ||
        installedServerNames.has(entry.name)
      )
    }
    return installedRecipeKeys.has(`${entry.name}@${entry.version}`)
  }

  function toggleExpanded(key: string) {
    setExpandedKeys(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const showConnectBanner =
    connectionMode === 'self-hosted' &&
    (connectionState === 'disconnected' || connectionState === 'rejected')
  // Computed once, rendered in BOTH the error early-return and the normal branch
  // so the connect prompt survives a catalog browse failure (DRY).
  const connectBanner = showConnectBanner ? (
    <div className="cu-banner cu-banner--info" role="status">
      <span>
        This deployment isn&apos;t connected to a registry. Connect it to publish and install
        connectors and plugins.
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

  if (error) {
    return (
      <div className="cu-registry-layout">
        {connectBanner}
        <div className="cu-card cu-card--viewport-fill cu-section-card">
          <div className="cu-card__body">
            <div className="cu-banner cu-banner--error">Error: {error}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="cu-registry-layout">
      {installError ? (
        <div className="cu-banner cu-banner--error cu-banner--dismissible" role="alert">
          <span>{installError}</span>
          <button
            type="button"
            className="cu-banner__dismiss"
            onClick={() => setInstallError('')}
            aria-label="Dismiss install error"
          >
            <IconX width={14} height={14} />
          </button>
        </div>
      ) : null}
      {connectBanner}
      <div className="cu-card cu-card--viewport-fill cu-section-card">
        <TablePanelHeader
          title={
            <>
              <IconStore />
              {isInitialLoad ? 'Marketplace' : `Marketplace (${filtered.length})`}
            </>
          }
          subtitle="Discover and install connectors and plugins from the Marketplace."
          actionsClassName="cu-registry-toolbar"
          actions={
            <>
              <SectionSearchInput
                value={search}
                onChange={setSearch}
                placeholder={`Search ${activeTab}...`}
                ariaLabel={`Search Marketplace ${activeTab}`}
                disabled={isInitialLoad}
              />
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
                <FilterSelect
                  value={modeFilter}
                  onChange={setModeFilter}
                  options={MODE_FILTER_OPTIONS}
                  disabled={isInitialLoad}
                  ariaLabel="Filter by mode"
                />
              </div>
              {!isInitialLoad ? (
                <span className="cu-registry-count">
                  {filtered.length} of {tabEntries.length} entries
                </span>
              ) : null}
              {connectionMode !== 'managed' ? (
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  onClick={() => router.push(CONTROL_ROUTES.marketplace.connect)}
                  disabled={isInitialLoad}
                >
                  Connect
                </button>
              ) : null}
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() =>
                  router.push(CONTROL_ROUTES.marketplace.publish({ type: activeEntryType }))
                }
                disabled={isInitialLoad}
              >
                + Publish to Marketplace
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                title="Manage org publish API keys (efrk_) for CI/scripts"
                onClick={() => router.push(CONTROL_ROUTES.marketplace.keys)}
                disabled={isInitialLoad}
              >
                Manage API keys
              </button>
            </>
          }
        />

        <TabBar<MarketplaceTab>
          ariaLabel="Marketplace entry types"
          activeValue={activeTab}
          className="cu-tabs--flush-top"
          options={[
            {
              value: 'connectors',
              href: CONTROL_ROUTES.marketplace.connectors,
              label: 'Connectors',
            },
            { value: 'plugins', href: CONTROL_ROUTES.marketplace.plugins, label: 'Plugins' },
          ]}
        />

        <div className="cu-table-wrap cu-marketplace-table-wrap">
          <table className="cu-table cu-table--header-band cu-expandable-table cu-marketplace-table">
            <thead>
              <TableHeaderRow columns={REGISTRY_COLUMNS} />
            </thead>
            <tbody>
              {isInitialLoad ? (
                <SkeletonTableRows columns={REGISTRY_COLUMNS.length} rows={5} />
              ) : (
                filtered.map(entry => {
                  const installed = isEntryInstalled(entry)
                  const entryKey = `${entry.name}@${entry.version}`
                  const installing = installingRecipeKey === entryKey
                  const expanded = expandedKeys.has(entryKey)
                  const typeMeta = entry.server_mode
                    ? `${entry.server_mode}${entry.transport ? ` / ${entry.transport}` : ''}`
                    : entry.recipe_type || '—'
                  return (
                    <Fragment key={entry.id}>
                      <tr
                        className="cu-table__row cu-table__row--clickable cu-expandable-row"
                        onClick={() => toggleExpanded(entryKey)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleExpanded(entryKey)
                          }
                        }}
                        tabIndex={0}
                        aria-expanded={expanded}
                        aria-controls={`marketplace-details-${entry.id}`}
                      >
                        <td className="cu-expandable-row__chevron" aria-hidden="true">
                          <IconChevronRight
                            className={expanded ? 'is-expanded' : undefined}
                            width={18}
                            height={18}
                          />
                        </td>
                        <td>
                          <div className="cu-registry-name">{entry.name}</div>
                          <div className="cu-registry-description" title={entry.description}>
                            {entry.description}
                          </div>
                        </td>
                        <td className="cu-code-text">{entry.version}</td>
                        <td>
                          {entry.visibility ? (
                            <span
                              className={`cu-registry-chip cu-registry-chip--visibility-${entry.visibility}`}
                            >
                              {entry.visibility === 'public' ? 'Public' : 'Private'}
                            </span>
                          ) : (
                            <span className="cu-muted">—</span>
                          )}
                        </td>
                        <td>{entry.downloads}</td>
                        <td
                          className="cu-table__cell-actions cu-marketplace-action-cell"
                          onClick={event => event.stopPropagation()}
                          onKeyDown={event => event.stopPropagation()}
                        >
                          {entry.entry_type === 'mcp-server' ? (
                            installed ? (
                              <button type="button" className="cu-btn cu-btn--sm" disabled>
                                Installed
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="cu-btn cu-btn--sm cu-btn--primary"
                                onClick={() => {
                                  const params = new URLSearchParams({
                                    entry: entry.name,
                                    version: entry.version,
                                  })
                                  router.push(
                                    CONTROL_ROUTES.marketplace.install(Object.fromEntries(params))
                                  )
                                }}
                              >
                                Install
                              </button>
                            )
                          ) : entry.recipe_meta?.recipeYaml ? (
                            installed ? (
                              <button type="button" className="cu-btn cu-btn--sm" disabled>
                                Installed
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="cu-btn cu-btn--sm cu-btn--primary"
                                disabled={installing}
                                onClick={() => void handleInstallRecipe(entry)}
                              >
                                {installing ? 'Installing...' : 'Install'}
                              </button>
                            )
                          ) : (
                            <span className="cu-registry-missing">No plugin data</span>
                          )}
                        </td>
                        <td
                          className="cu-table__cell-actions cu-marketplace-action-cell"
                          onClick={event => event.stopPropagation()}
                          onKeyDown={event => event.stopPropagation()}
                        >
                          <div className="cu-table-actions cu-marketplace-actions">
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--toolbar"
                              onClick={() =>
                                router.push(
                                  CONTROL_ROUTES.marketplace.editEntry(entry.name, entry.version)
                                )
                              }
                              aria-label={`Edit Marketplace metadata for ${entry.name} v${entry.version}`}
                              title={`Edit Marketplace metadata for ${entry.name} v${entry.version}`}
                            >
                              <IconPencil width={16} height={16} />
                            </button>
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--danger-icon"
                              onClick={() => {
                                setRemoveError('')
                                setRemoveTarget(entry)
                              }}
                              aria-label={`Remove ${entry.name} v${entry.version} from Marketplace`}
                              title={`Remove ${entry.name} v${entry.version} from Marketplace`}
                            >
                              <IconX width={16} height={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expanded ? (
                        <tr
                          id={`marketplace-details-${entry.id}`}
                          className="cu-expandable-detail-row"
                        >
                          <td colSpan={REGISTRY_COLUMNS.length}>
                            <div className="cu-expandable-detail cu-marketplace-row-detail">
                              <div className="cu-expandable-detail__fields">
                                <div className="cu-expandable-field">
                                  <span className="cu-expandable-field__label">Type</span>
                                  <span className="cu-registry-type-meta">{typeMeta}</span>
                                </div>
                                <div className="cu-expandable-field cu-expandable-field--wide">
                                  <div className="cu-expandable-tags">
                                    <span
                                      className="cu-registry-chip"
                                      style={{
                                        color: trustColor(entry.trust_level),
                                        background: trustBgColor(entry.trust_level),
                                        borderColor: trustColor(entry.trust_level),
                                      }}
                                    >
                                      {entry.trust_level.toUpperCase()}
                                    </span>
                                    <span
                                      className={`cu-registry-chip cu-registry-chip--quality-${entry.quality_tier}`}
                                    >
                                      {entry.quality_tier}
                                    </span>
                                    {entry.tags.map(tag => (
                                      <span key={tag} className="cu-registry-tag">
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })
              )}
              {!isInitialLoad && filtered.length === 0 ? (
                <tr>
                  <td colSpan={REGISTRY_COLUMNS.length} className="cu-empty">
                    No entries match your filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
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

function FilterSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
  ariaLabel: string
}) {
  return (
    <select
      value={value}
      onChange={event => onChange(event.target.value)}
      className="cu-input cu-input--compact cu-registry-filter"
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
