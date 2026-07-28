'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type RecipeSecretItem,
  apiSend,
  deleteRecipeSecret,
  getMcpServers,
  getRecipeSecrets,
  getRecipes,
} from '../lib/api'
import { createEmptyLlmKeyDraft, validateLlmSecretData } from '../lib/llm'
import { collectWorkflowRecipeSecretRefs } from '../lib/workflowRecipeSecretRefs'
import { useConfirmDialog } from './ConfirmDialog'
import { LlmCredentialFields } from './LlmCredentialFields'
import { SectionSearchInput } from './SectionSearchInput'
import { IconKey } from './Sidebar/icons'
import { TabBar } from './TabBar'
import { TablePanelHeader } from './TablePanelHeader'
import { useToast } from './Toast'
import { IconPencil, IconRefresh, IconX } from './icons'

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
  const [editingKeys, setEditingKeys] = useState<string[]>([])
  const [isLlmModalOpen, setIsLlmModalOpen] = useState(false)
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>(createEmptyLlmKeyDraft)
  // Stored data keys the editor queued for retirement (removed or renamed-away
  // extra slots). Sent as `removeKeys` on save — the draft is write-only and a
  // blank value is explicitly NOT a deletion server-side.
  const [removedKeys, setRemovedKeys] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
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
    return rows.filter(name => name.toLowerCase().includes(normalizedLlmSearch))
  }, [normalizedLlmSearch, rows])

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

  function closeLlmModal() {
    setIsLlmModalOpen(false)
    setEditingName('')
    setEditingKeys([])
    setKeyDraft(createEmptyLlmKeyDraft())
    setRemovedKeys([])
    setError('')
  }

  function openUpdate(name: string) {
    setEditingName(name)
    setEditingKeys(keysByName.get(name) ?? [])
    setKeyDraft(createEmptyLlmKeyDraft())
    setRemovedKeys([])
    setError('')
    setIsLlmModalOpen(true)
  }

  async function saveSecret() {
    const secretName = editingName.trim()
    if (!secretName) {
      setError('Secret name is required.')
      return
    }

    const stringData = Object.fromEntries(
      Object.entries(keyDraft)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value.length > 0)
    )
    // Defense in depth: the editor owns this invariant (it never reports a key
    // the draft is writing), and the server resolves "in data AND in
    // removeKeys" as retirement-wins, which would drop the value just typed.
    // The filter stays as a backstop for any future parent wiring the channel.
    const removeKeys = removedKeys.filter(key => !(key in stringData))
    // A retire-only edit is a real edit: `merge: true` accepts `removeKeys`
    // with no data at all, so only an empty-and-nothing-retired save is a
    // no-op worth blocking.
    if (Object.keys(stringData).length === 0 && removeKeys.length === 0) {
      setError('Provide at least one API key.')
      return
    }
    // Retiring every stored key without writing one 400s server-side with
    // "secret must retain at least one key" — a cryptic answer to a question
    // the client can answer itself from the keys it already knows.
    const survivingKeys = new Set([
      ...editingKeys.filter(key => !removeKeys.includes(key)),
      ...Object.keys(stringData),
    ])
    if (survivingKeys.size === 0) {
      setError('Removing every key would leave the secret empty — delete the secret instead.')
      return
    }
    // Slot-aware validation (spec R4.5.3), mirrored server-side in control-api.
    const slotErrors = validateLlmSecretData(stringData)
    if (slotErrors.length > 0) {
      setError(slotErrors[0])
      return
    }
    // Retirement is irreversible — the values are write-only, so a key deleted
    // by mistake cannot be restored from anything the UI holds. Confirm before
    // the write, naming exactly what goes.
    if (removeKeys.length > 0) {
      const confirmed = await confirm({
        title: 'Remove stored keys',
        message: `Permanently remove ${removeKeys.join(', ')} from secret ${secretName}? Their values cannot be recovered.`,
        confirmLabel: 'Remove and save',
        tone: 'danger',
      })
      if (!confirmed) return
    }

    setSaving(true)
    setError('')
    try {
      // merge:true → server-side read-then-replace that preserves the keys of
      // other providers stored in this shared LLM secret (spec R4 FIX 2b).
      // `removeKeys` (merge-only) is the deletion half of the same write: keys
      // the editor retired are dropped from the merged data. Omitted entirely
      // when nothing is retired so a plain update stays a pure overlay.
      await apiSend('PUT', '/api/v1/admin/secrets', {
        name: secretName,
        merge: true,
        stringData,
        ...(removeKeys.length > 0 ? { removeKeys } : {}),
      })
      showToast(`Secret ${secretName} updated.`, { tone: 'success' })
      await onChanged()
      closeLlmModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save secret')
    } finally {
      setSaving(false)
    }
  }

  async function loadMcpSecretReferences() {
    setMcpLoading(true)
    setMcpError('')
    try {
      const result = await getMcpServers()
      const usage = new Map<string, { servers: Set<string>; registryEntries: Set<string> }>()
      const addSecret = (secretName: string) => {
        if (!usage.has(secretName)) {
          usage.set(secretName, { servers: new Set<string>(), registryEntries: new Set<string>() })
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
          row.registryEntries.add(`${catalogId}@${catalogVersion}`)
        }
      }

      const nextRows = Array.from(usage.entries())
        .map(([name, details]) => ({
          name,
          servers: Array.from(details.servers).sort((a, b) => a.localeCompare(b)),
          registryEntries: Array.from(details.registryEntries).sort((a, b) => a.localeCompare(b)),
        }))
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
          <TabBar<SecretScope>
            ariaLabel="Secret scopes"
            activeValue={scope}
            className="cu-tabs--flush"
            options={[
              { value: 'llm', href: CONTROL_ROUTES.secrets.llm, label: 'LLM' },
              { value: 'mcp', href: CONTROL_ROUTES.secrets.connector, label: 'Connector' },
              { value: 'recipe', href: CONTROL_ROUTES.secrets.recipe, label: 'Recipe' },
            ]}
          />
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
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Name</th>
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
                      <div
                        className="cu-skeleton cu-skeleton--cell"
                        style={{ width: '4rem', marginLeft: 'auto' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : scope === 'llm' && filteredRows.length === 0 ? (
          <div className="cu-empty">
            {normalizedLlmSearch ? 'No LLM secrets match this search.' : 'No LLM secrets found.'}
          </div>
        ) : scope === 'llm' ? (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(name => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.35rem' }}>
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--toolbar"
                          onClick={() => openUpdate(name)}
                          aria-label={`Update LLM secret ${name}`}
                        >
                          <IconPencil width={16} height={16} />
                        </button>
                        <button
                          type="button"
                          className="cu-btn cu-btn--icon cu-btn--danger-icon"
                          onClick={() => void deleteSecret(name)}
                          disabled={deletingName === name}
                          aria-label={
                            deletingName === name ? 'Deleting…' : `Delete LLM secret ${name}`
                          }
                        >
                          <IconX width={16} height={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : scope === 'mcp' && isMcpInitialLoad ? (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '36%' }}>Attached connectors</th>
                  <th style={{ width: '34%' }}>Marketplace Source</th>
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
            </table>
          </div>
        ) : scope === 'mcp' && filteredMcpRows.length === 0 ? (
          <div className="cu-empty">
            {normalizedMcpSearch
              ? 'No connector secrets match this search.'
              : 'No connector secrets found.'}
          </div>
        ) : scope === 'mcp' ? (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '36%' }}>Attached connectors</th>
                  <th style={{ width: '34%' }}>Marketplace Source</th>
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filteredMcpRows.map(row => (
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
                        onClick={() =>
                          router.push(CONTROL_ROUTES.secrets.new({ scope: 'mcp', name: row.name }))
                        }
                        aria-label={`Add connector secret ${row.name}`}
                      >
                        Add
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : isRecipeInitialLoad ? (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '32%' }}>Keys</th>
                  <th style={{ width: '32%' }}>Used by recipes</th>
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
            </table>
          </div>
        ) : filteredRecipeRows.length === 0 ? (
          <div className="cu-empty">
            {normalizedRecipeSearch
              ? 'No recipe secrets match this search.'
              : 'No recipe secrets found.'}
          </div>
        ) : (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '32%' }}>Keys</th>
                  <th style={{ width: '32%' }}>Used by recipes</th>
                  <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filteredRecipeRows.map(row => (
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
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--toolbar"
                            onClick={() => navigateToRecipeEdit(row.name, row.namespace)}
                            aria-label={`Update recipe secret ${row.name}`}
                          >
                            <IconPencil width={16} height={16} />
                          </button>
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            onClick={() => void deleteRecipeSecretRow(row.name, row.namespace)}
                            disabled={recipeDeletingName === `${row.namespace}/${row.name}`}
                            aria-label={
                              recipeDeletingName === `${row.namespace}/${row.name}`
                                ? 'Deleting…'
                                : `Delete recipe secret ${row.name}`
                            }
                          >
                            <IconX width={16} height={16} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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

      {isLlmModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--cu-overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !saving) closeLlmModal()
          }}
        >
          <div
            className="cu-modal-panel"
            role="dialog"
            aria-labelledby="llm-secret-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="llm-secret-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Update LLM secret {editingName}
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={closeLlmModal}
                disabled={saving}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <div className="cu-form-stack" style={{ maxWidth: '100%' }}>
              <p className="cu-field__hint">
                Updates the listed keys and deletes the ones you remove here; every other key
                already stored in this secret is preserved.
              </p>
              <LlmCredentialFields
                draft={keyDraft}
                onChange={(dataKey, value) => setKeyDraft(prev => ({ ...prev, [dataKey]: value }))}
                existingKeys={editingKeys}
                // Identity-stable update: the editor re-reports on every change,
                // and a fresh array each time would re-render the modal for no
                // reason (and on mount, for an empty set).
                onRemovedKeysChange={next =>
                  setRemovedKeys(prev => (prev.join('\n') === next.join('\n') ? prev : next))
                }
                disabled={saving}
                pickerInline
              />
            </div>

            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={closeLlmModal}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={() => void saveSecret()}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Update secret'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </>
  )
}
