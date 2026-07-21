'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DashboardLayout } from '@components/DashboardLayout'
import { LoadingScreen } from '@components/LoadingScreen'
import { SectionSearchInput } from '@components/SectionSearchInput'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconPluginSdk } from '@components/Sidebar/icons'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { IconRefresh, IconX } from '@components/icons'
import { Button, Field, FormSection, SelectInput, TextInput } from '@components/ui'
import {
  type AdminUser,
  type PluginWorkloadSdkFamily,
  type PluginWorkloadSdkGrant,
  type PluginWorkloadSdkGrantInput,
  type PluginWorkloadSdkInvocation,
  type WorkflowRecipeResource,
  deletePluginWorkloadSdkGrant,
  getAdminUsers,
  getRecipes,
  isSilentApiError,
  listPluginWorkloadSdkGrants,
  listWorkflowGrants,
  searchPluginWorkloadSdkInvocations,
  upsertPluginWorkloadSdkGrant,
} from '@lib/api'
import { buildControlUiLoginPath, getCurrentControlUiPath } from '@lib/authRedirect'
import { useLlmAllowedModels } from '@lib/hooks/useLlmAllowedModels'
import {
  LLM_PROVIDER_OPTIONS,
  type LlmProvider,
  getModelOptions,
  getProviderLabel,
  inferProviderFromModels,
  normalizeProvider,
} from '@lib/llm'
import {
  appendCustomPluginWorkloadSdkModel,
  buildPluginWorkloadSdkModelOptions,
  getCustomPluginWorkloadSdkModelError,
  validateCustomPluginWorkloadSdkModel,
} from '@lib/pluginWorkloadSdkModels'
import { GrantsView, InvocationsView } from './Views'

type SdkView = 'grants' | 'invocations'

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean)
}

function hasWildcard(values: string[]): boolean {
  return values.some(v => v.includes('*'))
}

// A recipe that declares spec.pluginWorkloadSdk, projected to the fields needed
// to pre-fill a grant. This closes the operator-journey gap: instead of typing
// the (versioned) recipe name and re-entering what the recipe already declares,
// the operator picks the recipe and the form is seeded from its spec.
type SdkRecipeInfo = {
  namespace: string
  name: string
  families: PluginWorkloadSdkFamily[]
  allowedModels: string[]
  allowedEventTypes: string[]
  allowedCallers: string[]
  provider?: LlmProvider
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function toSdkRecipeInfo(recipe: WorkflowRecipeResource): SdkRecipeInfo | null {
  const spec = (recipe.spec ?? {}) as Record<string, unknown>
  const sdk = spec.pluginWorkloadSdk as Record<string, unknown> | undefined
  if (!sdk || typeof sdk !== 'object') return null
  const name = recipe.metadata?.name
  if (!name) return null
  const promptBridge = sdk.promptBridge as Record<string, unknown> | undefined
  const clientNotifications = sdk.clientNotifications as Record<string, unknown> | undefined
  const families: PluginWorkloadSdkFamily[] = []
  if (promptBridge) families.push('promptBridge')
  if (clientNotifications) families.push('clientNotifications')
  if (families.length === 0) return null
  const agent = spec.agent as Record<string, unknown> | undefined
  const provider = agent?.provider ? normalizeProvider(String(agent.provider)) : undefined
  return {
    namespace: recipe.metadata?.namespace || 'sandbox-recipes',
    name,
    families,
    allowedModels: asStringArray(promptBridge?.allowedModels),
    allowedEventTypes: asStringArray(clientNotifications?.allowedEventTypes),
    allowedCallers: asStringArray(sdk.allowedCallers),
    provider,
  }
}

function mergeAdminUsers(current: AdminUser[], incoming: AdminUser[]): AdminUser[] {
  const byId = new Map(current.map(user => [user.id, user]))
  for (const user of incoming) byId.set(user.id, user)
  return Array.from(byId.values()).sort((a, b) => a.email.localeCompare(b.email))
}

async function fetchUsersByRefs(userRefs: string[]): Promise<AdminUser[]> {
  const refs = Array.from(new Set(userRefs.map(ref => ref.trim()).filter(Boolean)))
  if (refs.length === 0) return []
  const results = await Promise.all(
    refs.map(ref =>
      getAdminUsers(ref)
        .then(res => (res.items ?? []).filter(user => user.id === ref))
        .catch(() => [] as AdminUser[])
    )
  )
  return results.flat()
}

export default function PluginWorkloadSdkPage() {
  const { authState } = useAuth()
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [view, setView] = useState<SdkView>('grants')

  const [grants, setGrants] = useState<PluginWorkloadSdkGrant[]>([])
  const [grantsLoading, setGrantsLoading] = useState(false)
  const [grantsError, setGrantsError] = useState('')
  const [grantSearch, setGrantSearch] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editing, setEditing] = useState<PluginWorkloadSdkGrant | 'new' | null>(null)

  const [invocations, setInvocations] = useState<PluginWorkloadSdkInvocation[]>([])
  const [invocationsLoading, setInvocationsLoading] = useState(false)
  const [invocationsError, setInvocationsError] = useState('')
  const [filterRecipe, setFilterRecipe] = useState('')
  const [filterMethod, setFilterMethod] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  // Platform user directory + SDK-enabled recipes, loaded once: the directory
  // resolves stored userRef UUIDs to names in the grants table, and the recipe
  // list drives the "pick a recipe" picker that seeds a new grant from its spec.
  const [users, setUsers] = useState<AdminUser[]>([])
  const [sdkRecipes, setSdkRecipes] = useState<SdkRecipeInfo[]>([])

  useEffect(() => {
    let cancelled = false
    getAdminUsers('')
      .then(r => {
        if (!cancelled) setUsers(r.items ?? [])
      })
      .catch(() => undefined)
    getRecipes()
      .then(r => {
        if (cancelled) return
        setSdkRecipes(
          (r.items ?? [])
            .map(toSdkRecipeInfo)
            .filter((info): info is SdkRecipeInfo => info !== null)
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const userMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of users) map.set(u.id, u.displayName || u.name || u.email)
    return map
  }, [users])

  const mergeLoadedUsers = useCallback((nextUsers: AdminUser[]) => {
    if (nextUsers.length > 0) setUsers(current => mergeAdminUsers(current, nextUsers))
  }, [])

  const loadGrants = useCallback(async () => {
    setGrantsLoading(true)
    setGrantsError('')
    try {
      const r = await listPluginWorkloadSdkGrants()
      const items = (r.items || []) as PluginWorkloadSdkGrant[]
      setGrants(items)
      const userRefs = items.flatMap(grant => grant.allowedUserRefs)
      void fetchUsersByRefs(userRefs)
        .then(mergeLoadedUsers)
        .catch(() => undefined)
    } catch (e) {
      if (isSilentApiError(e)) return
      setGrantsError(e instanceof Error ? e.message : 'Failed to load grants')
    } finally {
      setGrantsLoading(false)
    }
  }, [mergeLoadedUsers])

  const loadInvocations = useCallback(async () => {
    setInvocationsLoading(true)
    setInvocationsError('')
    try {
      const r = await searchPluginWorkloadSdkInvocations({
        recipeName: filterRecipe.trim() || undefined,
        method: filterMethod || undefined,
        status: filterStatus || undefined,
        limit: '100',
      })
      setInvocations((r.items || []) as PluginWorkloadSdkInvocation[])
    } catch (e) {
      if (isSilentApiError(e)) return
      setInvocationsError(e instanceof Error ? e.message : 'Failed to load invocations')
    } finally {
      setInvocationsLoading(false)
    }
  }, [filterRecipe, filterMethod, filterStatus])

  useEffect(() => {
    if (!authState.isLoading && !authState.isLoggedIn) {
      router.replace(buildControlUiLoginPath(getCurrentControlUiPath()))
    }
  }, [authState.isLoading, authState.isLoggedIn, router])

  useEffect(() => {
    if (!authState.isLoggedIn || authState.isLoading) return
    if (view === 'grants') void loadGrants()
    else void loadInvocations()
  }, [authState.isLoggedIn, authState.isLoading, view, loadGrants, loadInvocations])

  async function handleDelete(grant: PluginWorkloadSdkGrant) {
    const shouldDelete = await confirm({
      title: 'Delete SDK Grant',
      message: `Delete the ${grant.capabilityFamily} grant for ${grant.recipeNamespace}/${grant.recipeName}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setDeletingId(grant.id)
    try {
      await deletePluginWorkloadSdkGrant(grant.id, grant.recipeNamespace, grant.recipeName)
      showToast(`Grant for ${grant.recipeName}/${grant.capabilityFamily} deleted.`, {
        tone: 'success',
      })
      await loadGrants()
    } catch (e) {
      if (isSilentApiError(e)) return
      showToast(e instanceof Error ? e.message : 'Delete failed', { tone: 'error' })
    } finally {
      setDeletingId(null)
    }
  }

  async function handleSaved() {
    setEditing(null)
    await loadGrants()
  }

  if (authState.isLoading) {
    return <LoadingScreen />
  }
  if (!authState.isLoggedIn) return null

  const normalizedGrantSearch = grantSearch.trim().toLowerCase()
  const filteredGrants = normalizedGrantSearch
    ? grants.filter(g =>
        [g.recipeNamespace, g.recipeName, g.capabilityFamily]
          .join(' ')
          .toLowerCase()
          .includes(normalizedGrantSearch)
      )
    : grants
  const grantsInitialLoad = grantsLoading && grants.length === 0

  return (
    <DashboardLayout>
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title={
            <>
              <IconPluginSdk />
              Plugin SDK
            </>
          }
          subtitle="Per-recipe capability grants, quota, and invocation audit for promptBridge and clientNotifications."
          actions={
            <>
              {view === 'grants' ? (
                <>
                  <SectionSearchInput
                    value={grantSearch}
                    onChange={setGrantSearch}
                    placeholder="Search grants"
                    ariaLabel="Search grants"
                    disabled={grantsInitialLoad}
                  />
                  <Button
                    type="button"
                    className="cu-btn--icon cu-btn--toolbar"
                    onClick={() => void loadGrants()}
                    disabled={grantsLoading}
                    aria-label="Refresh grants"
                  >
                    <IconRefresh
                      className={grantsLoading ? 'cu-spin' : undefined}
                      width={18}
                      height={18}
                    />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setView('invocations')}
                  >
                    Invocations
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => setEditing('new')}
                    disabled={grantsInitialLoad}
                  >
                    New grant
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  className="cu-btn--icon cu-btn--toolbar"
                  onClick={() => void loadInvocations()}
                  disabled={invocationsLoading}
                  aria-label="Refresh invocations"
                >
                  <IconRefresh
                    className={invocationsLoading ? 'cu-spin' : undefined}
                    width={18}
                    height={18}
                  />
                </Button>
              )}
            </>
          }
        />

        {view === 'grants' ? (
          <GrantsView
            grants={filteredGrants}
            loading={grantsLoading}
            error={grantsError}
            deletingId={deletingId}
            userMap={userMap}
            onEdit={setEditing}
            onDelete={handleDelete}
          />
        ) : (
          <InvocationsView
            invocations={invocations}
            loading={invocationsLoading}
            error={invocationsError}
            filterRecipe={filterRecipe}
            filterMethod={filterMethod}
            filterStatus={filterStatus}
            onFilterRecipe={setFilterRecipe}
            onFilterMethod={setFilterMethod}
            onFilterStatus={setFilterStatus}
            onApply={() => void loadInvocations()}
          />
        )}
      </div>

      {editing ? (
        <GrantFormModal
          grant={editing === 'new' ? null : editing}
          sdkRecipes={sdkRecipes}
          onCancel={() => setEditing(null)}
          onSaved={handleSaved}
        />
      ) : null}
      {confirmDialog}
    </DashboardLayout>
  )
}

function GrantFormModal({
  grant,
  sdkRecipes,
  onCancel,
  onSaved,
}: {
  grant: PluginWorkloadSdkGrant | null
  sdkRecipes: SdkRecipeInfo[]
  onCancel: () => void
  onSaved: () => void
}) {
  const { showToast } = useToast()
  const isEdit = grant !== null
  const initialRecipeInfo = sdkRecipes.find(
    recipe => recipe.namespace === grant?.recipeNamespace && recipe.name === grant?.recipeName
  )
  const [recipeKey, setRecipeKey] = useState('')
  const [recipeNamespace, setRecipeNamespace] = useState(
    grant?.recipeNamespace ?? 'sandbox-recipes'
  )
  const [recipeName, setRecipeName] = useState(grant?.recipeName ?? '')
  const [family, setFamily] = useState<PluginWorkloadSdkFamily>(
    grant?.capabilityFamily ?? 'promptBridge'
  )
  const { models: allowedCatalog } = useLlmAllowedModels()
  // Prefer the grant's explicit provider (R1), then the recipe spec's provider.
  const providerExplicit = Boolean(grant?.provider) || Boolean(initialRecipeInfo?.provider)
  const [modelProvider, setModelProvider] = useState<LlmProvider>(
    (grant?.provider ? normalizeProvider(grant.provider) : undefined) ??
      initialRecipeInfo?.provider ??
      LLM_PROVIDER_OPTIONS[0].value
  )
  // Legacy grants have neither an explicit nor a recipe provider — infer it from
  // the allowed models once the allowlist loads, so the picklist filters to the
  // right provider. One-shot, and never overrides an explicit source.
  const didInferProviderRef = useRef(false)
  useEffect(() => {
    if (providerExplicit || didInferProviderRef.current || allowedCatalog.length === 0) return
    didInferProviderRef.current = true
    setModelProvider(inferProviderFromModels(grant?.allowedModels ?? [], allowedCatalog))
  }, [providerExplicit, allowedCatalog, grant?.allowedModels])
  const [allowedModels, setAllowedModels] = useState<string[]>(grant?.allowedModels ?? [])
  const [customModel, setCustomModel] = useState('')
  const [allowedEventTypes, setAllowedEventTypes] = useState(
    (grant?.allowedEventTypes ?? []).join(', ')
  )
  const [allowedTargetRefs, setAllowedTargetRefs] = useState(
    (grant?.allowedTargetRefs ?? []).join(', ')
  )
  const [allowedUserRefs, setAllowedUserRefs] = useState<string[]>(grant?.allowedUserRefs ?? [])
  const [allowedCallers, setAllowedCallers] = useState((grant?.allowedCallers ?? []).join(', '))
  const [users, setUsers] = useState<AdminUser[]>([])
  const [userSearch, setUserSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    getAdminUsers(userSearch.trim())
      .then(res => {
        if (!cancelled) setUsers(current => mergeAdminUsers(current, res.items ?? []))
      })
      .catch(() => {
        // Non-fatal: the dropdown shows its empty state and the admin can retry.
        if (!cancelled) setUsers([])
      })
    return () => {
      cancelled = true
    }
  }, [userSearch])
  useEffect(() => {
    let cancelled = false
    fetchUsersByRefs(allowedUserRefs)
      .then(resolved => {
        if (!cancelled) setUsers(current => mergeAdminUsers(current, resolved))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [allowedUserRefs])
  const [maxRequestsPerRun, setMaxRequestsPerRun] = useState(
    grant?.quotaLimits.maxRequestsPerRun?.toString() ?? ''
  )
  const [maxNotificationsPerRun, setMaxNotificationsPerRun] = useState(
    grant?.quotaLimits.maxNotificationsPerRun?.toString() ?? ''
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const recipeOptions = useMemo(
    () =>
      sdkRecipes.map(r => ({
        value: `${r.namespace}/${r.name}`,
        label: r.name,
        description: r.namespace,
      })),
    [sdkRecipes]
  )

  // Picking an SDK-enabled recipe seeds the form from its spec (recipe name,
  // declared event types, callers, provider/model) and pre-fills the notify
  // users from the recipe's access grant — so the operator configures access
  // once and the notify allowlist defaults to it (narrowable, security kept).
  async function applyRecipePrefill(key: string) {
    setRecipeKey(key)
    const info = sdkRecipes.find(r => `${r.namespace}/${r.name}` === key)
    if (!info) return
    setRecipeNamespace(info.namespace)
    setRecipeName(info.name)
    if (!info.families.includes(family)) setFamily(info.families[0])
    setAllowedEventTypes(info.allowedEventTypes.join(', '))
    setAllowedCallers(info.allowedCallers.join(', '))
    if (info.provider) {
      setModelProvider(info.provider)
    }
    setAllowedModels(info.allowedModels)
    setCustomModel('')
    try {
      const res = await listWorkflowGrants(info.namespace, info.name)
      setAllowedUserRefs((res.items ?? []).map(u => u.id))
    } catch {
      // Best-effort: leave users empty if the access grant can't be read.
    }
  }

  const modelsList = allowedModels
  const eventTypesList = parseList(allowedEventTypes)
  const callersList = parseList(allowedCallers)
  const wildcardPresent =
    hasWildcard(modelsList) ||
    hasWildcard(eventTypesList) ||
    hasWildcard(parseList(allowedTargetRefs)) ||
    hasWildcard(callersList)

  const providerModelOptions = useMemo(
    () => getModelOptions(allowedCatalog, modelProvider),
    [allowedCatalog, modelProvider]
  )
  const modelOptions = useMemo(
    () =>
      buildPluginWorkloadSdkModelOptions(allowedCatalog, modelProvider, allowedModels).map(
        model => ({
          value: model,
          label: model,
          description: providerModelOptions.includes(model) ? undefined : 'Configured custom model',
          badge: getProviderLabel(modelProvider),
        })
      ),
    [allowedCatalog, allowedModels, modelProvider, providerModelOptions]
  )
  const customModelValidation = validateCustomPluginWorkloadSdkModel(customModel, allowedModels)
  const customModelError = getCustomPluginWorkloadSdkModelError(customModel, allowedModels)
  const userOptions = useMemo(
    () =>
      users.map(user => ({
        value: user.id,
        label: user.displayName || user.name || user.email,
        description: user.email,
      })),
    [users]
  )
  const eventTypesMissing = family === 'clientNotifications' && eventTypesList.length === 0
  const modelsMissing = family === 'promptBridge' && modelsList.length === 0
  const callersMissing = callersList.length === 0
  const canSubmit =
    Boolean(recipeNamespace.trim() && recipeName.trim()) &&
    !wildcardPresent &&
    !eventTypesMissing &&
    !modelsMissing &&
    !callersMissing &&
    !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    const quotaLimits: PluginWorkloadSdkGrantInput['quotaLimits'] = {}
    const reqRun = Number.parseInt(maxRequestsPerRun, 10)
    if (Number.isFinite(reqRun) && reqRun > 0) quotaLimits.maxRequestsPerRun = reqRun
    const notifRun = Number.parseInt(maxNotificationsPerRun, 10)
    if (Number.isFinite(notifRun) && notifRun > 0) quotaLimits.maxNotificationsPerRun = notifRun

    // Edit mode: the upsert is a full-column overwrite, and the form does not expose
    // every quota/model field. Round-trip the unexposed fields from the original grant
    // so editing does not silently wipe values configured outside this form.
    if (grant) {
      if (grant.quotaLimits.maxInvocationsPerMinute !== undefined)
        quotaLimits.maxInvocationsPerMinute = grant.quotaLimits.maxInvocationsPerMinute
      if (grant.quotaLimits.maxNotificationsPerMinute !== undefined)
        quotaLimits.maxNotificationsPerMinute = grant.quotaLimits.maxNotificationsPerMinute
      if (grant.quotaLimits.maxOutputTokens !== undefined)
        quotaLimits.maxOutputTokens = grant.quotaLimits.maxOutputTokens
    }

    const payload: PluginWorkloadSdkGrantInput = {
      recipeNamespace: recipeNamespace.trim(),
      recipeName: recipeName.trim(),
      capabilityFamily: family,
      // R1: persist the explicit provider (control-api requires it for
      // promptBridge). Omitted for clientNotifications, which has no model.
      provider: family === 'promptBridge' ? modelProvider : undefined,
      allowedModels: family === 'promptBridge' ? modelsList : [],
      allowedEventTypes: family === 'clientNotifications' ? eventTypesList : [],
      allowedTargetRefs: family === 'clientNotifications' ? parseList(allowedTargetRefs) : [],
      allowedUserRefs: family === 'clientNotifications' ? allowedUserRefs : [],
      allowedCallers: callersList,
      quotaLimits,
    }
    // Edit mode: preserve modelPolicies, which the form does not expose, so the
    // full-column upsert does not wipe policies configured outside this form.
    if (grant && grant.modelPolicies) {
      payload.modelPolicies = grant.modelPolicies
    }
    try {
      await upsertPluginWorkloadSdkGrant(payload)
      showToast(`Grant saved for ${payload.recipeName}/${family}.`, { tone: 'success' })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save grant')
    } finally {
      setSubmitting(false)
    }
  }

  function addCustomModel() {
    if (!customModelValidation.ok) return
    setAllowedModels(current => appendCustomPluginWorkloadSdkModel(current, customModel))
    setCustomModel('')
  }

  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget && !submitting) onCancel()
      }}
    >
      <div
        className="cu-modal-panel"
        role="dialog"
        aria-label={isEdit ? 'Edit SDK grant' : 'New SDK grant'}
        onClick={e => e.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 className="cu-modal-panel__title">{isEdit ? 'Edit SDK grant' : 'New SDK grant'}</h3>
          <Button
            type="button"
            className="cu-btn--icon"
            variant="ghost"
            onClick={() => !submitting && onCancel()}
            aria-label="Close"
          >
            <IconX width={18} height={18} />
          </Button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="cu-modal-panel__body">
            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

            <FormSection title="Recipe binding">
              {!isEdit && recipeOptions.length > 0 ? (
                <Field
                  label="Recipe (declares the SDK)"
                  htmlFor="sdk-recipe-pick"
                  description="Pick an installed recipe that uses the SDK — the form is seeded from its spec (event types, callers, provider/model) and the notify users default to the recipe's access grant."
                >
                  <SelectInput
                    id="sdk-recipe-pick"
                    compact
                    value={recipeKey}
                    onChange={e => void applyRecipePrefill(e.target.value)}
                  >
                    <option value="">Select a recipe…</option>
                    {recipeOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label} ({option.description})
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              ) : null}
              <Field label="Recipe namespace" htmlFor="sdk-ns" required>
                <TextInput
                  id="sdk-ns"
                  compact
                  value={recipeNamespace}
                  onChange={e => setRecipeNamespace(e.target.value)}
                  disabled={isEdit}
                />
              </Field>
              <Field label="Recipe name" htmlFor="sdk-recipe" required>
                <TextInput
                  id="sdk-recipe"
                  compact
                  value={recipeName}
                  onChange={e => setRecipeName(e.target.value)}
                  disabled={isEdit}
                />
              </Field>
              <Field label="Capability family" htmlFor="sdk-family" required>
                <SelectInput
                  id="sdk-family"
                  compact
                  value={family}
                  onChange={e => setFamily(e.target.value as PluginWorkloadSdkFamily)}
                  disabled={isEdit}
                >
                  <option value="promptBridge">promptBridge</option>
                  <option value="clientNotifications">clientNotifications</option>
                </SelectInput>
              </Field>
            </FormSection>

            {family === 'promptBridge' ? (
              <FormSection title="promptBridge policy">
                <Field
                  label="Provider"
                  htmlFor="sdk-provider"
                  description="Must match the provider bound to the recipe's mcp-host. promptBridge can only use models from this provider."
                >
                  <SelectInput
                    id="sdk-provider"
                    compact
                    value={modelProvider}
                    onChange={e => {
                      const next = normalizeProvider(e.target.value)
                      setModelProvider(next)
                      // Unknown custom models are provider-scoped by this form:
                      // if the provider changes, the operator must re-add the
                      // exact configured model for the new provider.
                      setAllowedModels(prev =>
                        prev.filter(model => getModelOptions(allowedCatalog, next).includes(model))
                      )
                      setCustomModel('')
                    }}
                  >
                    {LLM_PROVIDER_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
                <Field
                  label="Allowed models"
                  htmlFor="sdk-models"
                  required
                  error={modelsMissing ? 'Select at least one model for promptBridge.' : undefined}
                  description="Models the workload may request. Only explicitly selected models are allowed."
                >
                  <SelectionDropdown
                    id="sdk-models"
                    value={allowedModels}
                    onChange={setAllowedModels}
                    options={modelOptions}
                    placeholder="Select approved models"
                    searchPlaceholder="Search models..."
                    selectionLabel="Selected models"
                    emptyLabel="No models for this provider."
                  />
                  <div className="cu-sdk-custom-model-row">
                    <TextInput
                      id="sdk-custom-model"
                      compact
                      monospace
                      value={customModel}
                      onChange={e => setCustomModel(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addCustomModel()
                        }
                      }}
                      invalid={Boolean(customModelError)}
                      aria-label="Configured model name"
                      aria-invalid={Boolean(customModelError) || undefined}
                      placeholder="configured-model-id"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={addCustomModel}
                      disabled={!customModelValidation.ok}
                    >
                      Add model
                    </Button>
                  </div>
                  {customModelError ? (
                    <span className="cu-field__error">{customModelError}</span>
                  ) : null}
                </Field>
              </FormSection>
            ) : (
              <FormSection title="clientNotifications policy">
                <Field
                  label="Allowed event types"
                  htmlFor="sdk-events"
                  required
                  error={eventTypesMissing ? 'At least one event type is required.' : undefined}
                  description="Comma- or newline-separated. Wildcards (*) are not allowed."
                >
                  <TextInput
                    id="sdk-events"
                    compact
                    monospace
                    value={allowedEventTypes}
                    onChange={e => setAllowedEventTypes(e.target.value)}
                    placeholder="lead.followup.due, support.summary.ready"
                  />
                </Field>
                <Field
                  label="Allowed target refs"
                  htmlFor="sdk-targets"
                  description="Opaque target references. Empty = none."
                >
                  <TextInput
                    id="sdk-targets"
                    compact
                    monospace
                    value={allowedTargetRefs}
                    onChange={e => setAllowedTargetRefs(e.target.value)}
                    placeholder="team.sales"
                  />
                </Field>
                <Field
                  label="Allowed users"
                  htmlFor="sdk-userrefs"
                  description="Platform users the workload may notify by userRef. Empty = none."
                >
                  <SelectionDropdown
                    id="sdk-userrefs"
                    value={allowedUserRefs}
                    onChange={setAllowedUserRefs}
                    onSearchQueryChange={setUserSearch}
                    options={userOptions}
                    placeholder="Select users…"
                    searchPlaceholder="Search by name or email…"
                    selectionLabel="Selected users"
                    emptyLabel="No users found."
                  />
                </Field>
              </FormSection>
            )}

            <FormSection title="Callers & quota">
              <Field
                label="Allowed callers"
                htmlFor="sdk-callers"
                required
                error={callersMissing ? 'At least one caller is required.' : undefined}
                description="Workload ids permitted to call. Comma- or newline-separated."
              >
                <TextInput
                  id="sdk-callers"
                  compact
                  monospace
                  value={allowedCallers}
                  onChange={e => setAllowedCallers(e.target.value)}
                  placeholder="api, worker"
                />
              </Field>
              {family === 'promptBridge' ? (
                <Field label="Max requests per run" htmlFor="sdk-maxreq">
                  <TextInput
                    id="sdk-maxreq"
                    compact
                    narrow
                    type="number"
                    min={1}
                    value={maxRequestsPerRun}
                    onChange={e => setMaxRequestsPerRun(e.target.value)}
                  />
                </Field>
              ) : (
                <Field label="Max notifications per run" htmlFor="sdk-maxnotif">
                  <TextInput
                    id="sdk-maxnotif"
                    compact
                    narrow
                    type="number"
                    min={1}
                    value={maxNotificationsPerRun}
                    onChange={e => setMaxNotificationsPerRun(e.target.value)}
                  />
                </Field>
              )}
            </FormSection>

            {wildcardPresent ? (
              <div className="cu-banner cu-banner--error">
                Wildcard (*) entries are not allowed in SDK grant allowlists.
              </div>
            ) : null}
          </div>
          <div className="cu-modal-panel__foot">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={!canSubmit}>
              {submitting ? 'Saving…' : 'Save grant'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
