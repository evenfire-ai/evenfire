'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DataTable, TableHeaderCell, useTableSort } from '@clerum/frontend-table-system'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type RecipeSecretItem,
  apiSend,
  deleteRecipeSecret,
  getMcpServers,
  getRecipeSecrets,
  getRecipes,
} from '../lib/api'
import { getProviderLabel, getProvidersWithCompleteCredentials } from '../lib/llm'
import { collectWorkflowRecipeSecretRefs } from '../lib/workflowRecipeSecretRefs'
import { useConfirmDialog } from './ConfirmDialog'
import { LlmProviderIcon } from './LlmProviderIcon'
import { LlmSecretUpdateModal } from './LlmSecretUpdateModal'
import { RowActionsMenu } from './RowActionsMenu'
import { SecretsScopeTabs } from './SecretsScopeTabs'
import { SectionSearchInput } from './SectionSearchInput'
import { IconKey } from './Sidebar/icons'
import { TablePanelHeader } from './TablePanelHeader'
import { useToast } from './Toast'
import { IconRefresh } from './icons'

type SecretItem = {
  name?: string
  metadata?: { name?: string }
  // Data-key names already stored in the Secret (values are never returned by
  // the listing — spec R4.5.3). Lights up the "present" chips in edit mode.
  keys?: string[]
}

type SecretScope = 'llm' | 'mcp' | 'recipe'
type McpSecretRow = {
  name: string
  servers: string[]
  registryEntries: string[]
  registrySources: Array<{ name: string; version: string }>
}
type RecipeSecretStatus = 'provisioned' | 'missing'
type RecipeSecretRowOwnership =
  | { kind: 'shared' }
  | { kind: 'owner-recipe'; recipeName: string }
  | { kind: 'unlabeled' }
  | null // missing rows: not yet provisioned, ownership chosen at create time.
type RecipeSecretRow = {
  name: string
  namespace: string
  keys: string[]
  recipes: string[]
  status: RecipeSecretStatus
  ownership: RecipeSecretRowOwnership
}

const DEFAULT_RECIPE_SECRET_NAMESPACE = 'sandbox-recipes'

export function SecretsTable({
  activeScope = 'llm',
  items,
  onChanged,
  onRefresh,
  refreshing,
  loading,
  onCreateLlmSecret,
  onCreateMcpSecret,
  onCreateRecipeSecret,
  onCreateRecipeSecretFor,
}: {
  activeScope?: SecretScope
  items: SecretItem[]
  onChanged: () => Promise<void>
  onRefresh?: () => void
  refreshing?: boolean
  loading?: boolean
  onCreateLlmSecret: () => void
  onCreateMcpSecret: () => void
  onCreateRecipeSecret: () => void
  onCreateRecipeSecretFor: (
    name: string,
    keys: string[],
    ownerRecipe?: string,
    namespace?: string
  ) => void
}) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [scope, setScopeState] = useState<SecretScope>(activeScope)
  useEffect(() => {
    setScopeState(activeScope)
  }, [activeScope])

  // LLM secrets state
  const [editingName, setEditingName] = useState('')
  const [deletingName, setDeletingName] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [llmSearchQuery, setLlmSearchQuery] = useState('')

  // connector secrets state
  const [mcpSearchQuery, setMcpSearchQuery] = useState('')
  const [mcpRows, setMcpRows] = useState<McpSecretRow[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState('')

  // Recipe secrets state
  const [recipeSearchQuery, setRecipeSearchQuery] = useState('')
  const [recipeRows, setRecipeRows] = useState<RecipeSecretRow[]>([])
  const [recipeLoading, setRecipeLoading] = useState(false)
  const [recipeError, setRecipeError] = useState('')
  const [recipeDeletingName, setRecipeDeletingName] = useState<string | null>(null)

  const rows = useMemo(
    () =>
      items
        .map(item => String(item.name || item.metadata?.name || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [items]
  )
  // Secret name -> stored data-key names, so the update modal can light up the
  // "present" chips for the row being edited (names only, never values).
  const keysByName = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const item of items) {
      const name = String(item.name || item.metadata?.name || '').trim()
      if (name) map.set(name, Array.isArray(item.keys) ? item.keys : [])
    }
    return map
  }, [items])
  const normalizedLlmSearch = llmSearchQuery.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!normalizedLlmSearch) return rows
    return rows.filter(name => {
      const providerNames = getProvidersWithCompleteCredentials(keysByName.get(name) ?? []).map(
        getProviderLabel
      )
      return [name, ...providerNames].join(' ').toLowerCase().includes(normalizedLlmSearch)
    })
  }, [keysByName, normalizedLlmSearch, rows])

  const normalizedMcpSearch = mcpSearchQuery.trim().toLowerCase()
  const filteredMcpRows = useMemo(() => {
    if (!normalizedMcpSearch) return mcpRows
    return mcpRows.filter(row => {
      return [row.name, ...row.servers, ...row.registryEntries]
        .join(' ')
        .toLowerCase()
        .includes(normalizedMcpSearch)
    })
  }, [mcpRows, normalizedMcpSearch])

  const normalizedRecipeSearch = recipeSearchQuery.trim().toLowerCase()
  const filteredRecipeRows = useMemo(() => {
    if (!normalizedRecipeSearch) return recipeRows
    return recipeRows.filter(row =>
      [row.name, ...row.keys, ...row.recipes]
        .join(' ')
        .toLowerCase()
        .includes(normalizedRecipeSearch)
    )
  }, [recipeRows, normalizedRecipeSearch])
  const llmSort = useTableSort<string, 'name' | 'providers'>({
    rows: filteredRows,
    defaultKey: 'name',
    identity: name => name,
    accessors: {
      name: name => name,
      providers: name =>
        getProvidersWithCompleteCredentials(keysByName.get(name) ?? [])
          .map(getProviderLabel)
          .join(', '),
    },
  })
  const mcpSort = useTableSort<McpSecretRow, 'name' | 'servers' | 'registry'>({
    rows: filteredMcpRows,
    defaultKey: 'name',
    identity: row => row.name,
    accessors: {
      name: row => row.name,
      servers: row => row.servers.join(', '),
      registry: row => row.registryEntries.join(', '),
    },
  })
  const recipeSort = useTableSort<RecipeSecretRow, 'name' | 'keys' | 'recipes'>({
    rows: filteredRecipeRows,
    defaultKey: 'name',
    identity: row => `${row.namespace}/${row.name}`,
    accessors: {
      name: row => `${row.namespace}/${row.name}`,
      keys: row => row.keys.join(', '),
      recipes: row => row.recipes.join(', '),
    },
  })

  function openUpdate(name: string) {
    setEditingName(name)
  }

  async function loadMcpSecretReferences() {
    setMcpLoading(true)
    setMcpError('')
    try {
      const result = await getMcpServers()
      const usage = new Map<
        string,
        { servers: Set<string>; registrySources: Map<string, { name: string; version: string }> }
      >()
      const addSecret = (secretName: string) => {
        if (!usage.has(secretName)) {
          usage.set(secretName, { servers: new Set<string>(), registrySources: new Map() })
        }
        return usage.get(secretName)!
      }

      for (const item of result.items ?? []) {
        const metadata = (item.metadata ?? {}) as Record<string, unknown>
        const labels = (metadata.labels ?? {}) as Record<string, string>
        const annotations = (metadata.annotations ?? {}) as Record<string, string>
        const serverName = typeof metadata.name === 'string' ? metadata.name.trim() : ''
        const spec = (item.spec ?? {}) as Record<string, unknown>
        const envSecret = (spec.envSecret ?? {}) as Record<string, unknown>
        const secretName = typeof envSecret.name === 'string' ? String(envSecret.name).trim() : ''
        if (!secretName) continue

        const row = addSecret(secretName)
        if (serverName) row.servers.add(serverName)
        // catalog-id / catalog-version live in ANNOTATIONS (org-scoped names like
        // "@org/name" contain '@' and '/', illegal as label values). Fall back to
        // labels so connectors installed before this change still associate.
        const catalogId = annotations['clerum.io/catalog-id'] ?? labels['clerum.io/catalog-id']
        const catalogVersion =
          annotations['clerum.io/catalog-version'] ?? labels['clerum.io/catalog-version']
        if (catalogId && catalogVersion) {
          row.registrySources.set(`${catalogId}@${catalogVersion}`, {
            name: catalogId,
            version: catalogVersion,
          })
        }
      }

      const nextRows = Array.from(usage.entries())
        .map(([name, details]) => {
          const registrySources = Array.from(details.registrySources.values()).sort((a, b) =>
            `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
          )
          return {
            name,
            servers: Array.from(details.servers).sort((a, b) => a.localeCompare(b)),
            registryEntries: registrySources.map(source => `${source.name}@${source.version}`),
            registrySources,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))

      setMcpRows(nextRows)
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Failed to load connector secret references')
    } finally {
      setMcpLoading(false)
    }
  }

  async function loadRecipeSecretsAndUsage() {
    setRecipeLoading(true)
    setRecipeError('')
    try {
      const [secretsResult, recipesResult] = await Promise.all([getRecipeSecrets(), getRecipes()])
      const secrets: RecipeSecretItem[] = secretsResult.items ?? []
      const provisionedNames = new Set(
        secrets.map(s => `${s.namespace || DEFAULT_RECIPE_SECRET_NAMESPACE}/${s.name}`)
      )

      // Scan all WorkflowRecipes for API-key style references. For each referenced
      // secret name, accumulate (a) which recipes reference it and (b) the union
      // of key names the recipes expect to be present.
      const usage = new Map<
        string,
        { name: string; namespace: string; recipes: Set<string>; declaredKeys: Set<string> }
      >()
      for (const recipe of recipesResult.items ?? []) {
        const meta = (recipe.metadata ?? {}) as Record<string, unknown>
        const recipeName = typeof meta.name === 'string' ? meta.name.trim() : ''
        if (!recipeName) continue
        const spec = (recipe.spec ?? {}) as Record<string, unknown>
        for (const ref of collectWorkflowRecipeSecretRefs(spec).values()) {
          const usageKey = `${ref.namespace}/${ref.secretName}`
          if (!usage.has(usageKey)) {
            usage.set(usageKey, {
              name: ref.secretName,
              namespace: ref.namespace,
              recipes: new Set<string>(),
              declaredKeys: new Set<string>(),
            })
          }
          const entry = usage.get(usageKey)!
          entry.recipes.add(recipeName)
          ref.keys.forEach(key => entry.declaredKeys.add(key))
        }
      }

      const provisionedRows: RecipeSecretRow[] = secrets.map(item => ({
        name: item.name,
        namespace: item.namespace || DEFAULT_RECIPE_SECRET_NAMESPACE,
        keys: Array.isArray(item.keys) ? item.keys : [],
        recipes: Array.from(
          usage.get(`${item.namespace || DEFAULT_RECIPE_SECRET_NAMESPACE}/${item.name}`)?.recipes ??
            []
        ).sort((a, b) => a.localeCompare(b)),
        status: 'provisioned',
        ownership: item.ownership ?? { kind: 'unlabeled' },
      }))

      const missingRows: RecipeSecretRow[] = Array.from(usage.entries())
        .filter(([key]) => !provisionedNames.has(key))
        .map(([, entry]) => ({
          name: entry.name,
          namespace: entry.namespace,
          keys: Array.from(entry.declaredKeys).sort((a, b) => a.localeCompare(b)),
          recipes: Array.from(entry.recipes).sort((a, b) => a.localeCompare(b)),
          status: 'missing',
          ownership: null,
        }))

      const nextRows = [...provisionedRows, ...missingRows].sort((a, b) => {
        // Surface missing rows first so they're not buried.
        if (a.status !== b.status) return a.status === 'missing' ? -1 : 1
        return `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
      })
      setRecipeRows(nextRows)
    } catch (e) {
      setRecipeError(e instanceof Error ? e.message : 'Failed to load recipe secrets')
    } finally {
      setRecipeLoading(false)
    }
  }

  useEffect(() => {
    if (scope === 'mcp') {
      void loadMcpSecretReferences()
    } else if (scope === 'recipe') {
      void loadRecipeSecretsAndUsage()
    }
  }, [scope])

  const isLlmInitialLoad = loading && rows.length === 0
  const isMcpInitialLoad = mcpLoading && mcpRows.length === 0
  const isRecipeInitialLoad = recipeLoading && recipeRows.length === 0
  const activeInitialLoad =
    scope === 'llm' ? isLlmInitialLoad : scope === 'mcp' ? isMcpInitialLoad : isRecipeInitialLoad
  const activeCount =
    scope === 'llm'
      ? filteredRows.length
      : scope === 'mcp'
        ? filteredMcpRows.length
        : filteredRecipeRows.length

  async function deleteSecret(name: string) {
    const ok = await confirm({
      title: 'Delete LLM Secret',
      message: `Delete LLM secret ${name}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setDeletingName(name)
    setError('')
    try {
      await apiSend('DELETE', `/api/v1/admin/secrets/${encodeURIComponent(name)}`)
      showToast(`Secret ${name} deleted.`, { tone: 'success' })
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete secret')
    } finally {
      setDeletingName(null)
    }
  }

  function navigateToRecipeEdit(name: string, namespace: string) {
    const qs = new URLSearchParams({ namespace })
    router.push(CONTROL_ROUTES.secrets.editRecipe(name, Object.fromEntries(qs)))
  }

  async function deleteRecipeSecretRow(name: string, namespace: string) {
    const ok = await confirm({
      title: 'Delete Recipe Secret',
      message: `Delete recipe secret ${name} from ${namespace}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    const deleteKey = `${namespace}/${name}`
    setRecipeDeletingName(deleteKey)
    setRecipeError('')
    try {
      await deleteRecipeSecret(name, namespace)
      showToast(`Secret ${name} deleted.`, { tone: 'success' })
      await loadRecipeSecretsAndUsage()
    } catch (e) {
      setRecipeError(e instanceof Error ? e.message : 'Failed to delete recipe secret')
    } finally {
      setRecipeDeletingName(null)
    }
  }

  return (
    <>
      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
        <TablePanelHeader
          title={
            <>
              <IconKey />
              {activeInitialLoad ? 'Secrets' : `Secrets (${activeCount})`}
            </>
          }
          subtitle="Manage LLM, connector, and recipe credentials in one place."
          actions={
            <>
              <SectionSearchInput
                value={
                  scope === 'llm'
                    ? llmSearchQuery
                    : scope === 'mcp'
                      ? mcpSearchQuery
                      : recipeSearchQuery
                }
                onChange={value => {
                  if (scope === 'llm') setLlmSearchQuery(value)
                  else if (scope === 'mcp') setMcpSearchQuery(value)
                  else setRecipeSearchQuery(value)
                }}
                placeholder="Search secrets"
                ariaLabel={
                  scope === 'llm'
                    ? 'Search LLM secrets'
                    : scope === 'mcp'
                      ? 'Search connector secrets'
                      : 'Search recipe secrets'
                }
                disabled={activeInitialLoad}
              />
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={() => {
                  if (scope === 'llm') void onRefresh?.()
                  else if (scope === 'mcp') void loadMcpSecretReferences()
                  else void loadRecipeSecretsAndUsage()
                }}
                disabled={
                  activeInitialLoad ||
                  (scope === 'llm' ? refreshing : scope === 'mcp' ? mcpLoading : recipeLoading)
                }
                aria-label={
                  scope === 'llm'
                    ? refreshing
                      ? 'Refreshing...'
                      : 'Reload LLM secrets'
                    : scope === 'mcp'
                      ? mcpLoading
                        ? 'Refreshing...'
                        : 'Reload connector secret references'
                      : recipeLoading
                        ? 'Refreshing...'
                        : 'Reload recipe secrets'
                }
              >
                <IconRefresh
                  className={
                    (scope === 'llm' && refreshing) ||
                    (scope === 'mcp' && mcpLoading) ||
                    (scope === 'recipe' && recipeLoading)
                      ? 'cu-spin'
                      : undefined
                  }
                  width={18}
                  height={18}
                />
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() => {
                  if (scope === 'llm') onCreateLlmSecret()
                  else if (scope === 'mcp') onCreateMcpSecret()
                  else onCreateRecipeSecret()
                }}
                disabled={activeInitialLoad}
              >
                {scope === 'llm'
                  ? 'Add LLM secret'
                  : scope === 'mcp'
                    ? 'Add connector secret'
                    : 'Add recipe secret'}
              </button>
            </>
          }
        />

        <div className="cu-card__body cu-card__body--auto cu-secrets-strip">
          <SecretsScopeTabs activeValue={scope} />
        </div>

        {scope === 'llm' && error && (
          <div className="cu-card__body cu-card__body--auto cu-secrets-message-strip">
            <div className="cu-banner cu-banner--error">{error}</div>
          </div>
        )}

        {scope === 'mcp' && mcpError && (
          <div className="cu-card__body cu-card__body--auto cu-secrets-message-strip">
            <div className="cu-banner cu-banner--error">{mcpError}</div>
          </div>
        )}

        {scope === 'recipe' && recipeError && (
          <div className="cu-card__body cu-card__body--auto cu-secrets-message-strip">
            <div className="cu-banner cu-banner--error">{recipeError}</div>
          </div>
        )}

        {scope === 'llm' && isLlmInitialLoad ? (
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table cu-table--header-band">
              <thead>
                <tr>
                  <TableHeaderCell label="Name" />
                  <TableHeaderCell label="Providers" />
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 3 }).map((_, idx) => (
                  <tr key={idx}>
                    <td>
                      <div
                        className="cu-skeleton cu-skeleton--cell"
                        style={{ width: `${55 + ((idx * 13) % 25)}%` }}
                      />
                    </td>
                    <td>
                      <div className="cu-skeleton cu-skeleton--cell" style={{ width: '8rem' }} />
                    </td>
                    <td>
                      <div
                        className="cu-skeleton cu-skeleton--cell"
                        style={{ width: '4rem', marginLeft: 'auto' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        ) : scope === 'llm' && filteredRows.length === 0 ? (
          <div className="cu-empty">
            {normalizedLlmSearch ? 'No LLM secrets match this search.' : <>No LLM secrets found.</>}
          </div>
        ) : scope === 'llm' ? (
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table cu-table--header-band">
              <thead>
                <tr>
                  <TableHeaderCell
                    activeDirection={llmSort.key === 'name' ? llmSort.direction : null}
                    label="Name"
                    onSort={() => llmSort.sortBy('name')}
                  />
                  <TableHeaderCell
                    activeDirection={llmSort.key === 'providers' ? llmSort.direction : null}
                    label="Providers"
                    onSort={() => llmSort.sortBy('providers')}
                  />
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {llmSort.sortedRows.map(name => {
                  const providers = getProvidersWithCompleteCredentials(keysByName.get(name) ?? [])
                  return (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>
                        {providers.length > 0 ? (
                          <div className="cu-chip-row" aria-label={`Providers for ${name}`}>
                            {providers.map(provider => {
                              const label = getProviderLabel(provider)
                              return (
                                <span key={provider} className="cu-chip">
                                  <LlmProviderIcon provider={provider} label={label} />
                                  {label}
                                </span>
                              )
                            })}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--cu-text-soft)' }}>—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '0.35rem' }}>
                          <RowActionsMenu
                            ariaLabel={`Actions for LLM secret ${name}`}
                            horizontalTrigger
                            actions={[
                              {
                                key: 'update',
                                label: 'Update',
                                onClick: () => openUpdate(name),
                              },
                              {
                                key: 'delete',
                                label: deletingName === name ? 'Deleting…' : 'Delete',
                                danger: true,
                                disabled: deletingName === name,
                                onClick: () => void deleteSecret(name),
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </DataTable>
          </div>
        ) : scope === 'mcp' && isMcpInitialLoad ? (
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table cu-table--header-band">
              <thead>
                <tr>
                  <TableHeaderCell label="Name" />
                  <TableHeaderCell label="Attached connectors" style={{ width: '36%' }} />
                  <TableHeaderCell label="Marketplace Source" style={{ width: '34%' }} />
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 3 }).map((_, idx) => (
                  <tr key={idx}>
                    <td>
                      <div
                        className="cu-skeleton cu-skeleton--cell"
                        style={{ width: `${52 + ((idx * 14) % 28)}%` }}
                      />
                    </td>
                    <td>
                      <div className="cu-skeleton cu-skeleton--cell" style={{ width: '70%' }} />
                    </td>
                    <td>
                      <div className="cu-skeleton cu-skeleton--cell" style={{ width: '55%' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        ) : scope === 'mcp' && filteredMcpRows.length === 0 ? (
          <div className="cu-empty">
            {normalizedMcpSearch
              ? 'No connector secrets match this search.'
              : 'No connector secrets found.'}
          </div>
        ) : scope === 'mcp' ? (
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table cu-table--header-band">
              <thead>
                <tr>
                  <TableHeaderCell
                    activeDirection={mcpSort.key === 'name' ? mcpSort.direction : null}
                    label="Name"
                    onSort={() => mcpSort.sortBy('name')}
                  />
                  <TableHeaderCell
                    activeDirection={mcpSort.key === 'servers' ? mcpSort.direction : null}
                    label="Attached connectors"
                    onSort={() => mcpSort.sortBy('servers')}
                    style={{ width: '36%' }}
                  />
                  <TableHeaderCell
                    activeDirection={mcpSort.key === 'registry' ? mcpSort.direction : null}
                    label="Marketplace Source"
                    onSort={() => mcpSort.sortBy('registry')}
                    style={{ width: '34%' }}
                  />
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {mcpSort.sortedRows.map(row => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td style={{ color: 'var(--cu-text-soft)', fontSize: '0.8125rem' }}>
                      {row.servers.length > 0
                        ? `${row.servers.length} server(s): ${row.servers.join(', ')}`
                        : 'Not yet attached to a connector.'}
                    </td>
                    <td style={{ color: 'var(--cu-text-soft)', fontSize: '0.8125rem' }}>
                      {row.registryEntries.length > 0
                        ? row.registryEntries.join(', ')
                        : 'Created manually or source unknown.'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="cu-btn cu-btn--primary cu-btn--sm"
                        onClick={() => {
                          const source =
                            row.registrySources.length === 1 ? row.registrySources[0] : undefined
                          router.push(
                            CONTROL_ROUTES.secrets.new({
                              scope: 'mcp',
                              name: row.name,
                              registryEntry: source?.name,
                              registryVersion: source?.version,
                            })
                          )
                        }}
                        aria-label={`Add connector secret ${row.name}`}
                      >
                        Add
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        ) : isRecipeInitialLoad ? (
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table cu-table--header-band">
              <thead>
                <tr>
                  <TableHeaderCell label="Name" />
                  <TableHeaderCell label="Keys" style={{ width: '32%' }} />
                  <TableHeaderCell label="Used by recipes" style={{ width: '32%' }} />
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 3 }).map((_, idx) => (
                  <tr key={idx}>
                    <td>
                      <div
                        className="cu-skeleton cu-skeleton--cell"
                        style={{ width: `${48 + ((idx * 11) % 30)}%` }}
                      />
                    </td>
                    <td>
                      <div className="cu-skeleton cu-skeleton--cell" style={{ width: '60%' }} />
                    </td>
                    <td>
                      <div className="cu-skeleton cu-skeleton--cell" style={{ width: '50%' }} />
                    </td>
                    <td>
                      <div
                        className="cu-skeleton cu-skeleton--cell"
                        style={{ width: '4rem', marginLeft: 'auto' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        ) : filteredRecipeRows.length === 0 ? (
          <div className="cu-empty">
            {normalizedRecipeSearch
              ? 'No recipe secrets match this search.'
              : 'No recipe secrets found.'}
          </div>
        ) : (
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table cu-table--header-band">
              <thead>
                <tr>
                  <TableHeaderCell
                    activeDirection={recipeSort.key === 'name' ? recipeSort.direction : null}
                    label="Name"
                    onSort={() => recipeSort.sortBy('name')}
                  />
                  <TableHeaderCell
                    activeDirection={recipeSort.key === 'keys' ? recipeSort.direction : null}
                    label="Keys"
                    onSort={() => recipeSort.sortBy('keys')}
                    style={{ width: '32%' }}
                  />
                  <TableHeaderCell
                    activeDirection={recipeSort.key === 'recipes' ? recipeSort.direction : null}
                    label="Used by recipes"
                    onSort={() => recipeSort.sortBy('recipes')}
                    style={{ width: '32%' }}
                  />
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {recipeSort.sortedRows.map(row => (
                  <tr key={`${row.status}:${row.namespace}:${row.name}`}>
                    <td>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span>{row.name}</span>
                        <span className="cu-chip" title={`Secret namespace: ${row.namespace}`}>
                          {row.namespace}
                        </span>
                        {row.status === 'missing' ? (
                          <span
                            className="cu-chip"
                            style={{
                              color: 'var(--cu-warn-text, var(--cu-text-soft))',
                              borderColor: 'var(--cu-warn-border, var(--cu-border-subtle))',
                            }}
                          >
                            Missing
                          </span>
                        ) : null}
                        {row.ownership?.kind === 'shared' ? (
                          <span className="cu-chip" title="Any recipe can reference this secret">
                            Shared
                          </span>
                        ) : null}
                        {row.ownership?.kind === 'owner-recipe' ? (
                          <span
                            className="cu-chip"
                            title={`Only ${row.ownership.recipeName} can reference this secret`}
                          >
                            Owner: {row.ownership.recipeName}
                          </span>
                        ) : null}
                        {row.ownership?.kind === 'unlabeled' ? (
                          <span
                            className="cu-chip"
                            style={{
                              color: 'var(--cu-warn-text, var(--cu-text-soft))',
                              borderColor: 'var(--cu-warn-border, var(--cu-border-subtle))',
                            }}
                            title="Secret has neither owner-recipe nor shared label — WRC will refuse to project it"
                          >
                            Unlabeled
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ color: 'var(--cu-text-soft)', fontSize: '0.8125rem' }}>
                      {row.keys.length > 0
                        ? row.keys.join(', ')
                        : row.status === 'missing'
                          ? 'No keys declared by recipe.'
                          : 'No keys defined.'}
                    </td>
                    <td style={{ color: 'var(--cu-text-soft)', fontSize: '0.8125rem' }}>
                      {row.recipes.length > 0
                        ? `${row.recipes.length} recipe(s): ${row.recipes.join(', ')}`
                        : 'Not yet referenced by a recipe.'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {row.status === 'missing' ? (
                        <button
                          type="button"
                          className="cu-btn cu-btn--primary cu-btn--sm"
                          onClick={() =>
                            onCreateRecipeSecretFor(
                              row.name,
                              row.keys,
                              row.recipes.length === 1 ? row.recipes[0] : undefined,
                              row.namespace
                            )
                          }
                          aria-label={`Add recipe secret ${row.name}`}
                        >
                          Add
                        </button>
                      ) : (
                        <div style={{ display: 'inline-flex', gap: '0.35rem' }}>
                          <RowActionsMenu
                            ariaLabel={`Actions for recipe secret ${row.name}`}
                            horizontalTrigger
                            actions={[
                              {
                                key: 'update',
                                label: 'Update',
                                onClick: () => navigateToRecipeEdit(row.name, row.namespace),
                              },
                              {
                                key: 'delete',
                                label:
                                  recipeDeletingName === `${row.namespace}/${row.name}`
                                    ? 'Deleting…'
                                    : 'Delete',
                                danger: true,
                                disabled: recipeDeletingName === `${row.namespace}/${row.name}`,
                                onClick: () => void deleteRecipeSecretRow(row.name, row.namespace),
                              },
                            ]}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}

        {scope === 'mcp' ? (
          <div className="cu-card__body cu-card__body--auto cu-secrets-message-strip">
            <div className="cu-banner cu-banner--info">
              Connector secret lifecycle in UI currently supports creation. Editing, deleting, and
              listing all secrets in the <code>mcp-server</code> namespace requires backend API
              support.
            </div>
          </div>
        ) : null}

        {scope === 'recipe' && recipeRows.some(row => row.status === 'missing') ? (
          <div className="cu-card__body cu-card__body--auto cu-secrets-message-strip">
            <div className="cu-banner cu-banner--info">
              Some recipes reference secrets that don&apos;t exist yet. Click <strong>Add</strong>
              on a Missing row to provision the Secret in the namespace shown on that row.
            </div>
          </div>
        ) : null}
      </div>

      {editingName ? (
        <LlmSecretUpdateModal
          key={editingName}
          secretName={editingName}
          existingKeys={keysByName.get(editingName) ?? []}
          onClose={() => setEditingName('')}
          onChanged={onChanged}
        />
      ) : null}
      {confirmDialog}
    </>
  )
}
