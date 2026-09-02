'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DashboardLayout } from '@components/DashboardLayout'
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
  type PluginWorkloadSdkPromptTarget,
  type WorkflowRecipeResource,
  deletePluginWorkloadSdkGrant,
  getAdminUsers,
  getPluginWorkloadSdkLegacyInventory,
  getRecipes,
  isSilentApiError,
  listLlmHostSecrets,
  listPluginWorkloadSdkGrants,
  listWorkflowGrants,
  searchPluginWorkloadSdkInvocations,
  upsertPluginWorkloadSdkGrant,
} from '@lib/api'
import {
  type CodexSubscriptionConnectionView,
  isAssignableCodexGrant,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
} from '@lib/codexSubscription'
import { isDisabledCapabilityError } from '@lib/codexSubscriptionFeature'
import { useLlmAllowedModels } from '@lib/hooks/useLlmAllowedModels'
import {
  LLM_PROVIDER_OPTIONS,
  type LlmProvider,
  OPENAI_SUBSCRIPTION_PROVIDER,
  buildPromptBridgeTargetPolicy,
  getModelOptions,
  getPromptBridgeCredentialSlotOptions,
  getProviderLabel,
  normalizeProvider,
} from '@lib/llm'
import { shouldApplyRecipePrefill } from '@lib/pluginWorkloadSdkPrefill'
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
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const [view, setView] = useState<SdkView>('grants')

  const [grants, setGrants] = useState<PluginWorkloadSdkGrant[]>([])
  const [grantsLoading, setGrantsLoading] = useState(true)
  const [grantsError, setGrantsError] = useState('')
  const [legacyInventory, setLegacyInventory] = useState<Awaited<
    ReturnType<typeof getPluginWorkloadSdkLegacyInventory>
  > | null>(null)
  const [legacyInventoryLoading, setLegacyInventoryLoading] = useState(true)
  const [legacyInventoryError, setLegacyInventoryError] = useState('')
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
    setLegacyInventoryLoading(true)
    setLegacyInventoryError('')
    try {
      const r = await listPluginWorkloadSdkGrants()
      const items = (r.items || []) as PluginWorkloadSdkGrant[]
      setGrants(items)
      try {
        const inventory = await getPluginWorkloadSdkLegacyInventory()
        setLegacyInventory(inventory)
      } catch (e) {
        setLegacyInventory(null)
        setLegacyInventoryError(
          isSilentApiError(e)
            ? 'SDK migration inventory could not be verified; refresh after signing in again.'
            : e instanceof Error
              ? e.message
              : 'Failed to load SDK migration inventory'
        )
      } finally {
        setLegacyInventoryLoading(false)
      }
      const userRefs = items.flatMap(grant => grant.allowedUserRefs)
      void fetchUsersByRefs(userRefs)
        .then(mergeLoadedUsers)
        .catch(() => undefined)
    } catch (e) {
      setGrantsError(
        isSilentApiError(e)
          ? 'SDK grants could not be verified; refresh after signing in again.'
          : e instanceof Error
            ? e.message
            : 'Failed to load grants'
      )
      setLegacyInventoryLoading(false)
    } finally {
      setGrantsLoading(false)
      // Inventory is a safety prerequisite independent of the grants request;
      // never leave the page in an apparently loading-but-editable state when
      // the inventory request failed or the grants request short-circuited.
      setLegacyInventoryLoading(false)
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
    if (view === 'grants') void loadGrants()
    else void loadInvocations()
  }, [view, loadGrants, loadInvocations])

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
                    disabled={
                      grantsInitialLoad ||
                      legacyInventoryLoading ||
                      Boolean(legacyInventoryError) ||
                      Boolean(grantsError)
                    }
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
                    disabled={
                      grantsInitialLoad ||
                      legacyInventoryLoading ||
                      Boolean(legacyInventoryError) ||
                      Boolean(grantsError)
                    }
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
            legacyInventory={legacyInventory}
            legacyInventoryLoading={legacyInventoryLoading}
            legacyInventoryError={legacyInventoryError}
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
  const [modelProvider, setModelProvider] = useState<LlmProvider>(
    (grant?.provider ? normalizeProvider(grant.provider) : undefined) ??
      initialRecipeInfo?.provider ??
      LLM_PROVIDER_OPTIONS[0].value
  )
  // Legacy grants deliberately start empty: they must be explicitly migrated by
  // an operator, never inferred from a flat provider/model list.
  const [promptTargets, setPromptTargets] = useState<PluginWorkloadSdkPromptTarget[]>(
    grant?.promptTargets ?? []
  )
  const [targetRef, setTargetRef] = useState('')
  const [targetModel, setTargetModel] = useState('')
  const [credentialSlot, setCredentialSlot] = useState('')
  const [availableCredentialKeys, setAvailableCredentialKeys] = useState<string[]>([])
  // Codex (oauth-broker) targets choose an EXISTING permitted subscription
  // grant instead of a Secret data key. Only connected grants with a ready
  // catalog are listed, and the model picker narrows to that grant's enabled
  // non-stale models — the same "choose, don't create" lock Hosts follow.
  const isCodexProvider = modelProvider === OPENAI_SUBSCRIPTION_PROVIDER
  const [codexConnectionRef, setCodexConnectionRef] = useState('')
  const [codexConnections, setCodexConnections] = useState<CodexSubscriptionConnectionView[]>([])
  const [codexModels, setCodexModels] = useState<string[]>([])
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
  // Recipe prefill resolves the access grant asynchronously. Keep that
  // response from overwriting an operator's explicit recipient choice when
  // the request finishes after the user has opened the picker.
  const recipePrefillRequest = useRef(0)
  const allowedUserRefsEdited = useRef(false)

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
  useEffect(() => {
    let cancelled = false
    listLlmHostSecrets()
      .then(result => {
        if (cancelled) return
        setAvailableCredentialKeys(
          Array.from(new Set((result.items ?? []).flatMap(item => item.keys ?? []))).sort((a, b) =>
            a.localeCompare(b)
          )
        )
      })
      .catch(() => {
        // The save endpoint remains the source of truth. Without a readable
        // key-name catalog we fail closed in this form rather than asking an
        // operator to type a potentially unrelated slot.
        if (!cancelled) setAvailableCredentialKeys([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!isCodexProvider) return
    let cancelled = false
    listCodexSubscriptionConnections()
      .then(connections => {
        if (cancelled) return
        setCodexConnections(connections.filter(isAssignableCodexGrant))
      })
      .catch(err => {
        if (cancelled) return
        setCodexConnections([])
        if (!isDisabledCapabilityError(err)) {
          setError(err instanceof Error ? err.message : 'Could not load ChatGPT subscriptions')
        }
      })
    return () => {
      cancelled = true
    }
  }, [isCodexProvider])
  useEffect(() => {
    if (!isCodexProvider || !codexConnectionRef) {
      setCodexModels([])
      return
    }
    let cancelled = false
    listCodexConnectionModels(codexConnectionRef)
      .then(models => {
        if (cancelled) return
        setCodexModels(models.filter(row => row.enabled && !row.stale).map(row => row.model))
      })
      .catch(() => {
        if (!cancelled) setCodexModels([])
      })
    return () => {
      cancelled = true
    }
  }, [isCodexProvider, codexConnectionRef])
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
    const requestId = ++recipePrefillRequest.current
    allowedUserRefsEdited.current = false
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
    // Recipe metadata only pre-fills a *new* reviewed target draft. It does
    // not turn legacy grant data into an implicit routing policy.
    setTargetModel(info.allowedModels[0] ?? '')
    setTargetRef('')
    setCredentialSlot('')
    try {
      const res = await listWorkflowGrants(info.namespace, info.name)
      // A later recipe selection invalidates this response. Once the operator
      // edits the picker, preserve that explicit decision instead of applying
      // a stale/default access grant over it.
      if (
        !shouldApplyRecipePrefill(
          requestId,
          recipePrefillRequest.current,
          allowedUserRefsEdited.current
        )
      )
        return
      setAllowedUserRefs((res.items ?? []).map(u => u.id))
    } catch {
      // Best-effort: leave users empty if the access grant can't be read.
    }
  }

  function handleAllowedUserRefsChange(next: string[]) {
    allowedUserRefsEdited.current = true
    setAllowedUserRefs(next)
  }

  const eventTypesList = parseList(allowedEventTypes)
  const callersList = parseList(allowedCallers)
  const wildcardPresent =
    promptTargets.some(target =>
      [
        target.targetRef,
        target.provider,
        target.model,
        target.credentialSlot,
        target.connectionRef ?? '',
      ].some(value => value.includes('*'))
    ) ||
    hasWildcard(eventTypesList) ||
    hasWildcard(parseList(allowedTargetRefs)) ||
    hasWildcard(callersList)

  const providerModelOptions = useMemo(
    () => (isCodexProvider ? codexModels : getModelOptions(allowedCatalog, modelProvider)),
    [allowedCatalog, codexModels, isCodexProvider, modelProvider]
  )
  const credentialSlotOptions = useMemo(
    () => getPromptBridgeCredentialSlotOptions(modelProvider, availableCredentialKeys),
    [availableCredentialKeys, modelProvider]
  )
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
  const targetsMissing = family === 'promptBridge' && promptTargets.length === 0
  const callersMissing = callersList.length === 0
  const canSubmit =
    Boolean(recipeNamespace.trim() && recipeName.trim()) &&
    !wildcardPresent &&
    !eventTypesMissing &&
    !targetsMissing &&
    !callersMissing &&
    !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    // Edit mode: the upsert is a full-column overwrite, and the form does not expose
    // the quota fields. Round-trip every quota key from the original grant except the
    // deprecated ones (per-run: issue #348; maxOutputTokens: J8 — no longer enforced)
    // so editing does not silently wipe values configured outside this form.
    const quotaLimits: PluginWorkloadSdkGrantInput['quotaLimits'] = {}
    if (grant) {
      const {
        maxRequestsPerRun: _d1,
        maxNotificationsPerRun: _d2,
        maxOutputTokens: _d3,
        ...keptQuotaLimits
      } = grant.quotaLimits
      Object.assign(quotaLimits, keptQuotaLimits)
    }

    const routingPolicy =
      family === 'promptBridge' ? buildPromptBridgeTargetPolicy(promptTargets) : undefined
    const payload: PluginWorkloadSdkGrantInput = {
      recipeNamespace: recipeNamespace.trim(),
      recipeName: recipeName.trim(),
      capabilityFamily: family,
      // R1: persist the explicit provider (control-api requires it for
      // promptBridge). Omitted for clientNotifications, which has no model.
      provider: routingPolicy?.provider,
      // Retained only as legacy inventory metadata; runtime selection uses the
      // ordered targets below and never falls back to this flat list.
      allowedModels: routingPolicy?.allowedModels ?? [],
      allowedEventTypes: family === 'clientNotifications' ? eventTypesList : [],
      allowedTargetRefs: family === 'clientNotifications' ? parseList(allowedTargetRefs) : [],
      allowedUserRefs: family === 'clientNotifications' ? allowedUserRefs : [],
      allowedCallers: callersList,
      quotaLimits,
      promptTargets: routingPolicy?.promptTargets,
      defaultTargetRef: routingPolicy?.defaultTargetRef,
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

  function addPromptTarget() {
    const model = targetModel.trim()
    const slot = credentialSlot.trim()
    const connectionRef = codexConnectionRef.trim()
    const ref = targetRef.trim() || `${modelProvider}-${model}-${promptTargets.length + 1}`
    // Codex targets bind a permitted subscription grant and carry no static
    // Secret slot; API-key targets keep requiring a provider-owned slot.
    if (!model || !ref || (isCodexProvider ? !connectionRef : !slot)) return
    if (
      promptTargets.some(
        target =>
          target.targetRef === ref || (target.provider === modelProvider && target.model === model)
      )
    ) {
      setError('Each promptBridge target must have a unique ref and provider/model pair.')
      return
    }
    setPromptTargets(current => [
      ...current,
      isCodexProvider
        ? { targetRef: ref, provider: modelProvider, model, credentialSlot: '', connectionRef }
        : { targetRef: ref, provider: modelProvider, model, credentialSlot: slot },
    ])
    setTargetRef('')
    setTargetModel('')
    setCredentialSlot('')
    setError('')
  }

  function moveTarget(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= promptTargets.length) return
    setPromptTargets(current => {
      const next = [...current]
      const currentTarget = next[index]!
      next[index] = next[nextIndex]!
      next[nextIndex] = currentTarget
      return next
    })
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
                  label="Target provider"
                  htmlFor="sdk-provider"
                  description="Add one reviewed target at a time. The first target is the default and later targets are the only permitted fallback order."
                >
                  <SelectInput
                    id="sdk-provider"
                    compact
                    value={modelProvider}
                    onChange={e => {
                      const next = normalizeProvider(e.target.value)
                      setModelProvider(next)
                      setTargetModel('')
                      setCredentialSlot('')
                      setCodexConnectionRef('')
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
                  label="Target model"
                  htmlFor="sdk-target-model"
                  required
                  error={
                    targetsMissing
                      ? 'Add at least one reviewed target for promptBridge.'
                      : undefined
                  }
                  description="The model must be enabled for the selected provider."
                >
                  <SelectInput
                    id="sdk-target-model"
                    compact
                    value={targetModel}
                    onChange={e => setTargetModel(e.target.value)}
                  >
                    <option value="">Select enabled model…</option>
                    {providerModelOptions.map(model => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
                {isCodexProvider ? (
                  <Field
                    label="Codex subscription"
                    htmlFor="sdk-codex-connection"
                    required
                    description="Choose an existing connected ChatGPT subscription grant. Grants are created in Secrets & Connections; this policy only selects one, and only its enabled models can be added."
                  >
                    <SelectInput
                      id="sdk-codex-connection"
                      compact
                      value={codexConnectionRef}
                      onChange={e => {
                        setCodexConnectionRef(e.target.value)
                        setTargetModel('')
                      }}
                    >
                      <option value="">Select connected subscription…</option>
                      {codexConnections.map(connection => (
                        <option key={connection.connectionKey} value={connection.connectionKey}>
                          {connection.displayName
                            ? `${connection.displayName} (${connection.connectionKey})`
                            : connection.connectionKey}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                ) : (
                  <Field
                    label="Credential slot"
                    htmlFor="sdk-credential-slot"
                    required
                    description="Sanitized Secret data-key identity owned by this provider. Its value is never displayed or sent to the workload."
                  >
                    <SelectInput
                      id="sdk-credential-slot"
                      compact
                      value={credentialSlot}
                      onChange={e => setCredentialSlot(e.target.value)}
                    >
                      <option value="">Select provider-owned slot…</option>
                      {credentialSlotOptions.map(slot => (
                        <option key={slot} value={slot}>
                          {slot}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                )}
                <Field
                  label="Target reference"
                  htmlFor="sdk-target-ref"
                  description="Stable caller-selectable identifier. Empty creates a deterministic local suggestion."
                >
                  <div className="cu-sdk-custom-model-row">
                    <TextInput
                      id="sdk-target-ref"
                      compact
                      monospace
                      value={targetRef}
                      onChange={e => setTargetRef(e.target.value)}
                      aria-label="PromptBridge target reference"
                      placeholder="primary-zai"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={addPromptTarget}
                      disabled={
                        !targetModel.trim() ||
                        (isCodexProvider ? !codexConnectionRef.trim() : !credentialSlot.trim())
                      }
                    >
                      Add target
                    </Button>
                  </div>
                </Field>
                {promptTargets.length > 0 ? (
                  <div className="cu-field__hint" aria-label="Ordered promptBridge targets">
                    {promptTargets.map((target, index) => (
                      <div key={target.targetRef} className="cu-sdk-custom-model-row">
                        <code>
                          {index === 0 ? 'default · ' : `fallback ${index} · `}
                          {target.targetRef}: {getProviderLabel(target.provider as LlmProvider)} /{' '}
                          {target.model} /{' '}
                          {target.connectionRef
                            ? `sub:${target.connectionRef}`
                            : target.credentialSlot}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => moveTarget(index, -1)}
                          disabled={index === 0}
                        >
                          Up
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => moveTarget(index, 1)}
                          disabled={index === promptTargets.length - 1}
                        >
                          Down
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setPromptTargets(current => current.filter((_, i) => i !== index))
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
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
                    onChange={handleAllowedUserRefsChange}
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

            <FormSection title="Callers">
              <Field
                label="Allowed callers"
                htmlFor="sdk-callers"
                required
                error={callersMissing ? 'At least one caller is required.' : undefined}
                description="Workload ids permitted to call. Comma- or newline-separated. Per-minute rate limits use platform defaults and are not set in this form; a grant may still carry a per-minute override via the API."
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
