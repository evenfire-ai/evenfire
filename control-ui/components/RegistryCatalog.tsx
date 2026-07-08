'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SectionSearchInput } from '@components/SectionSearchInput'
import { IconStore } from '@components/Sidebar/icons'
import { SkeletonTableRows } from '@components/SkeletonTableRows'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { IconPencil, IconX } from '@components/icons'
import {
  type RegistryEntry,
  deleteRegistryEntry,
  getRegistryCatalog,
  installRecipeFromRegistry,
} from '../lib/api'
import { trustBgColor, trustColor } from '../lib/trustLevel'

const TYPE_LABELS: Record<string, string> = {
  'mcp-server': 'Connector',
  recipe: 'Plugin',
}

const MODE_FILTER_OPTIONS = [
  { value: 'all', label: 'All Modes' },
  { value: 'local', label: 'Local' },
  { value: 'remote', label: 'Remote' },
  { value: 'workflow', label: 'Workflow' },
  { value: 'only-workloads', label: 'Only Workloads' },
]

const REGISTRY_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'category', label: 'Category' },
  { key: 'version', label: 'Version' },
  { key: 'trust', label: 'Trust' },
  { key: 'quality', label: 'Quality' },
  { key: 'visibility', label: 'Visibility' },
  { key: 'downloads', label: 'Downloads' },
  { key: 'actions', align: 'right', ariaLabel: 'Actions' },
]

export default function RegistryCatalog() {
  const router = useRouter()
  const { showToast } = useToast()
  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [installedCatalogKeys, setInstalledCatalogKeys] = useState<Set<string>>(new Set())
  const [installedServerNames, setInstalledServerNames] = useState<Set<string>>(new Set())
  const [installedRecipeKeys, setInstalledRecipeKeys] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installingRecipeKey, setInstallingRecipeKey] = useState('')
  const [installError, setInstallError] = useState('')

  // Filters
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [modeFilter, setModeFilter] = useState<string>('all')

  // Remove-from-Marketplace flow (developer action; §6.2 of the workflow UX spec).
  const [removeTarget, setRemoveTarget] = useState<RegistryEntry | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')

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
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Failed to remove from Marketplace')
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
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Failed to install plugin')
    } finally {
      setInstallingRecipeKey('')
    }
  }

  useEffect(() => {
    loadData()
  }, [])

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    return entries.filter(e => {
      if (typeFilter !== 'all' && e.entry_type !== typeFilter) return false
      if (categoryFilter !== 'all' && e.category !== categoryFilter) return false
      if (modeFilter !== 'all') {
        if (modeFilter === 'local' && e.server_mode !== 'local') return false
        if (modeFilter === 'remote' && e.server_mode !== 'remote') return false
        if (modeFilter === 'workflow' && e.recipe_type !== 'workflow') return false
        if (modeFilter === 'only-workloads' && e.recipe_type !== 'only-workloads') return false
      }
      if (search) {
        const q = search.toLowerCase()
        return (
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.tags.some(t => t.toLowerCase().includes(q))
        )
      }
      return true
    })
  }, [entries, search, typeFilter, categoryFilter, modeFilter])

  const isInitialLoad = loading && entries.length === 0

  function isEntryInstalled(entry: RegistryEntry): boolean {
    if (entry.entry_type === 'mcp-server') {
      return (
        installedCatalogKeys.has(`${entry.name}@${entry.version}`) ||
        installedServerNames.has(entry.name)
      )
    }
    if (entry.entry_type === 'recipe') {
      return installedRecipeKeys.has(`${entry.name}@${entry.version}`)
    }
    return false
  }

  if (error) {
    return (
      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
        <div className="cu-card__body">
          <div className="cu-banner cu-banner--error">Error: {error}</div>
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
      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
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
                placeholder="Search entries..."
                ariaLabel="Search Marketplace entries"
                disabled={isInitialLoad}
              />
              <div className="cu-registry-filter-group">
                <FilterSelect
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={[
                    { value: 'all', label: 'All Types' },
                    { value: 'mcp-server', label: 'Connectors' },
                    { value: 'recipe', label: 'Plugins' },
                  ]}
                  disabled={isInitialLoad}
                />
                <FilterSelect
                  value={categoryFilter}
                  onChange={setCategoryFilter}
                  options={[
                    { value: 'all', label: 'All Categories' },
                    ...categories.map(c => ({ value: c, label: c })),
                  ]}
                  disabled={isInitialLoad}
                />
                <FilterSelect
                  value={modeFilter}
                  onChange={setModeFilter}
                  options={MODE_FILTER_OPTIONS}
                  disabled={isInitialLoad}
                />
              </div>
              {!isInitialLoad ? (
                <span className="cu-registry-count">
                  {filtered.length} of {entries.length} entries
                </span>
              ) : null}
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() => router.push('/registry/publish')}
                disabled={isInitialLoad}
              >
                + Publish to Marketplace
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                title="Manage org publish API keys (efrk_) for CI/scripts"
                onClick={() => router.push('/registry/keys')}
                disabled={isInitialLoad}
              >
                Manage API keys
              </button>
            </>
          }
        />

        <div className="cu-table-wrap">
          <table className="cu-table cu-table--header-band">
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
                  const trust = trustColor(entry.trust_level)
                  const detailHref = `/registry/entries/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`
                  const openDetail = (): void => {
                    router.push(detailHref)
                  }
                  return (
                    <tr
                      key={entry.id}
                      className="cu-table__row cu-table__row--clickable"
                      onClick={openDetail}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openDetail()
                        }
                      }}
                      tabIndex={0}
                      role="link"
                      aria-label={`Open ${entry.name} v${entry.version}`}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <div className="cu-registry-name">{entry.name}</div>
                        <div className="cu-registry-description" title={entry.description}>
                          {entry.description}
                        </div>
                        {entry.tags.length > 0 && (
                          <div className="cu-registry-tags">
                            {entry.tags.slice(0, 4).map(tag => (
                              <span key={tag} className="cu-registry-tag">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>

                      <td>
                        <div className="cu-registry-type-cell">
                          <span
                            className={`cu-registry-chip cu-registry-chip--${entry.entry_type}`}
                          >
                            {TYPE_LABELS[entry.entry_type]}
                          </span>
                          {entry.server_mode && (
                            <span className="cu-registry-type-meta">
                              {entry.server_mode}
                              {entry.transport ? ` / ${entry.transport}` : ''}
                            </span>
                          )}
                          {entry.recipe_type && (
                            <span className="cu-registry-type-meta">{entry.recipe_type}</span>
                          )}
                        </div>
                      </td>

                      <td>{entry.category}</td>

                      <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                        {entry.version}
                      </td>

                      <td>
                        <span
                          className="cu-registry-chip"
                          style={{
                            color: trust,
                            background: trustBgColor(entry.trust_level),
                            borderColor: `${trust}55`,
                          }}
                        >
                          {entry.trust_level.toUpperCase()}
                        </span>
                      </td>

                      <td>
                        <span
                          className={`cu-registry-chip ${
                            entry.quality_tier === 'verified'
                              ? 'cu-registry-chip--quality-verified'
                              : 'cu-registry-chip--quality-unverified'
                          }`}
                        >
                          {entry.quality_tier}
                        </span>
                      </td>

                      <td>
                        {/* Visibility comes from the registry's full entry row. If it's
                            absent we render nothing rather than assume a value. */}
                        {entry.visibility ? (
                          <span
                            className={`cu-registry-chip ${
                              entry.visibility === 'public'
                                ? 'cu-registry-chip--visibility-public'
                                : 'cu-registry-chip--visibility-private'
                            }`}
                          >
                            {entry.visibility === 'public' ? 'Public' : 'Private'}
                          </span>
                        ) : null}
                      </td>

                      <td>{entry.downloads}</td>

                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
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
                                  const params = new URLSearchParams()
                                  params.set('entry', entry.name)
                                  params.set('version', entry.version)
                                  router.push(`/registry/install?${params.toString()}`)
                                }}
                                title={
                                  entry.server_mode === 'remote'
                                    ? 'Remote connector — credentials are forwarded through the egress proxy'
                                    : undefined
                                }
                              >
                                Install
                              </button>
                            )
                          ) : entry.entry_type === 'recipe' && entry.recipe_meta?.recipeYaml ? (
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
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--toolbar"
                            onClick={() =>
                              router.push(
                                `/registry/entries/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}/edit`
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
                  )
                })
              )}
              {!isInitialLoad && filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="cu-empty">
                    No entries match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {removeTarget && (
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
              Marketplace. Already-installed copies stay running — this only affects
              discoverability.
            </p>
            {removeError && (
              <div className="cu-banner cu-banner--error" role="alert">
                {removeError}
              </div>
            )}
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
      )}
    </div>
  )
}

function FilterSelect({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="cu-input cu-input--compact cu-registry-filter"
      disabled={disabled}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
