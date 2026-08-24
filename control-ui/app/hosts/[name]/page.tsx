'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DetailPageShell } from '@components/DetailPageShell'
import { useToast } from '@components/Toast'
import { HOST_DEFAULT_TAB, HOST_TABS } from '@constants/hostDetails'
import { CONTROL_ROUTES } from '@constants/routes'
import { CodexAgentAssignment } from '../../../components/CodexAgentAssignment'
import { HostAccessTab } from '../../../components/HostAccessTab'
import { HostAdvancedTab } from '../../../components/HostAdvancedTab'
import type { HostGuardrails } from '../../../components/HostGuardrailsSection/types'
import { HostIdentityTab } from '../../../components/HostIdentityTab'
import { LlmProviderConfig } from '../../../components/LlmProviderConfig'
import { IconRobot } from '../../../components/Sidebar/icons'
import { IconCheck, IconPencil, IconX } from '../../../components/icons'
import { apiSend, getHost, getHostDetailBundle } from '../../../lib/api'
import { CODEX_UNASSIGNED_CONNECTION_KEY } from '../../../lib/codexSubscription'
import { useLlmAllowedModels } from '../../../lib/hooks/useLlmAllowedModels'
import { FIRST_PARTY_CHANNEL_WORKFLOW_CONTROL_SCOPES } from '../../../lib/hostWorkflowControl'
import {
  type HostAllowedModel,
  LLM_EMPTY_TRIGGER_ERROR,
  type LlmPolicy,
  type LlmProvider,
  buildAllowedModelsSpec,
  constrainModelOptions,
  getActiveCredentialKeys,
  getModelOptions,
  getProviderLabel,
  hostModelNameError,
  isOpenAiFamily,
  isProviderUsable,
  llmChainRequiresSecret,
  normalizeAllowedModels,
  normalizeLlmPolicy,
  normalizeProvider,
  projectCredentialDraft,
  resolveCodexGrantModel,
  resolveDefaultModel,
  validateLlmPolicy,
  validateLlmSecretData,
} from '../../../lib/llm'
import type { HostTab } from './types'

const TAB_LABELS: Record<HostTab, string> = {
  details: 'Overview',
  model: 'Models & creds',
  advanced: 'Advanced',
  contexts: 'Context',
  access: 'Access',
  identity: 'Identity',
}

const TAB_SLUGS: Record<HostTab, string> = {
  details: 'overview',
  model: 'model',
  advanced: 'advanced',
  contexts: 'contexts',
  access: 'access',
  identity: 'identity',
}

function parseHostTab(value: string | undefined): HostTab {
  return HOST_TABS.find(tab => TAB_SLUGS[tab] === value) ?? HOST_DEFAULT_TAB
}

// Cron×stateless: map the machine-readable suspend-blocked reason to
// operator-friendly text. Every other reason renders verbatim.
function friendlyLifecycleReason(reason: string): string {
  if (reason === 'SuspendBlocked: activeCronSchedules') {
    return 'Not suspending: active scheduled tasks keep this agent awake'
  }
  return reason
}

export default function HostDetailsPage() {
  const params = useParams<{ name: string; tab?: string }>()
  const router = useRouter()
  const { showToast } = useToast()
  const { confirmDialog } = useConfirmDialog()

  const routeName = decodeURIComponent(params.name || '')
  const mountedRef = useRef(true)

  // AP-6 — resourceVersion of the READ THE EDIT FORM WAS BUILT FROM.
  // Captured at form load (loadData), NOT from the pre-save re-fetch inside
  // saveHost: the optimistic-concurrency guard must cover the whole human
  // edit window. Anchoring it to the pre-save re-fetch would only guard the
  // milliseconds between that re-fetch and the PUT, silently blessing any
  // concurrent change that landed while the operator was editing — exactly
  // the stale-echo overwrite AP-6 exists to prevent.
  const formResourceVersionRef = useRef('')

  const [activeTab, setActiveTab] = useState<HostTab>(() => parseHostTab(params.tab))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initialLoading, setInitialLoading] = useState(true)

  const [editingOverview, setEditingOverview] = useState(false)
  const [editingModel, setEditingModel] = useState(false)
  const [editingContext, setEditingContext] = useState(false)
  const [showDeleteAgentConfirm, setShowDeleteAgentConfirm] = useState(false)
  const [deletingAgent, setDeletingAgent] = useState(false)
  const [deleteAgentDialogError, setDeleteAgentDialogError] = useState('')

  const [hostNameDraft, setHostNameDraft] = useState(routeName)
  const [hostDisplayDraft, setHostDisplayDraft] = useState('')
  const [contextRefDraft, setContextRefDraft] = useState('')
  // Last server-backed snapshot of the Overview-owned fields, captured at every
  // (re)load. Cancel (and re-opening Edit) reverts the whole class of Overview
  // drafts to THIS — the last SAVED state — so a discarded edit (e.g. a Display
  // name typed then cancelled) can never leak into a later saveHost PUT.
  const savedOverviewRef = useRef({
    hostName: routeName,
    hostDisplay: '',
    contextRef: '',
    channels: [] as string[],
    stateless: false,
  })
  const [providerDraft, setProviderDraft] = useState<LlmProvider>('openai')
  // Model options are the operator allowlist (enabled only). The host's saved
  // model is always kept selectable even if it fell out of the allowlist
  // (preexisting resources are not interrupted — spec R3.7).
  const {
    models: allowedCatalog,
    loading: modelsLoading,
    error: modelsError,
  } = useLlmAllowedModels()
  const [modelNameDraft, setModelNameDraft] = useState('')
  const [connectionRefDraft, setConnectionRefDraft] = useState(CODEX_UNASSIGNED_CONNECTION_KEY)
  const [codexModels, setCodexModels] = useState<string[]>([])
  const catalogForEditor = useMemo(() => {
    if (providerDraft !== 'codex-subscription' || codexModels.length === 0) return allowedCatalog
    const others = allowedCatalog.filter(row => row.provider !== 'codex-subscription')
    return [
      ...others,
      ...codexModels.map(model => ({
        id: `codex:${model}`,
        provider: 'codex-subscription',
        model,
        vendor: 'OpenAI',
        display_name: model,
        context_window_tokens: null,
        enabled: true,
        source: 'discovery' as const,
        stale: false,
      })),
    ]
  }, [allowedCatalog, providerDraft, codexModels])
  const [secretRefDraft, setSecretRefDraft] = useState('')
  // Fallback policy (spec §3-R5). `undefined` = the Host has no llmPolicy.
  const [llmPolicyDraft, setLlmPolicyDraft] = useState<LlmPolicy | undefined>(undefined)
  // Per-host model allowlist subset (spec.allowedModels, Topic 3a). Empty = the
  // host offers the full global allowlist per provider (back-compat default).
  const [allowedModelsDraft, setAllowedModelsDraft] = useState<HostAllowedModel[]>([])
  // Write-only credential rotations for this Host's Secret (spec Topic 1b R5).
  // A blank field leaves the stored key unchanged; a typed value rotates ONLY
  // that dataKey via the merge PUT. Reset on every (re)load.
  const [llmKeyDraft, setLlmKeyDraft] = useState<Record<string, string>>({})
  // Extra fallback slots whose stored key can be retired after their fallback
  // was removed (spec Topic 1b R5: offer to RETIRE via removeKeys). Applied on
  // save unless the operator opts out.
  const [retireCandidates, setRetireCandidates] = useState<string[]>([])
  // Data keys present per LLM Secret name, so the fallback credentialSlot
  // dropdown can offer extra keys (e.g. `claude-api-key-fb1`) — never free text.
  const [secretKeysByName, setSecretKeysByName] = useState<Record<string, string[]>>({})
  const [channelsDraft, setChannelsDraft] = useState<string[]>([])
  const [approvalToolsData, setApprovalToolsData] = useState<Record<string, boolean> | undefined>(
    undefined
  )
  const [guardrailsData, setGuardrailsData] = useState<HostGuardrails | undefined>(undefined)
  const [statelessDraft, setStatelessDraft] = useState(false)
  const [savedStateless, setSavedStateless] = useState(false)
  const [lifecycleState, setLifecycleState] = useState('')
  const [lifecycleReason, setLifecycleReason] = useState('')
  const [statelessRejectionMessage, setStatelessRejectionMessage] = useState('')

  const [availableContexts, setAvailableContexts] = useState<string[]>([])
  const [availableSecrets, setAvailableSecrets] = useState<string[]>([])

  const providerModelOptions = useMemo(
    () => getModelOptions(catalogForEditor, providerDraft),
    [catalogForEditor, providerDraft]
  )
  // The EFFECTIVE per-host subset to persist (Topic 3a): the raw draft pruned to
  // the providers actually in this host's domain (primary + fallbacks — so a
  // stale subset for a provider that is no longer used is never emitted), then
  // collapsed by `buildAllowedModelsSpec` (unrestricted/all-selected providers
  // dropped). The single source of truth for BOTH the save payload and the
  // read-only summary, so the displayed state always matches what is saved.
  const effectiveAllowedModelsSpec = useMemo(() => {
    const activeProviders = new Set<string>([
      providerDraft,
      ...(llmPolicyDraft?.fallbacks ?? []).map(fallback => fallback.provider),
    ])
    return buildAllowedModelsSpec(
      allowedModelsDraft.filter(entry => activeProviders.has(entry.provider)),
      allowedCatalog
    )
  }, [allowedModelsDraft, allowedCatalog, providerDraft, llmPolicyDraft])
  // The effective subset grouped by provider, for the read-only Overview summary.
  // Empty = the host is unrestricted (offers the full global allowlist).
  const allowedModelsSummary = useMemo(() => {
    const byProvider = new Map<string, string[]>()
    for (const entry of effectiveAllowedModelsSpec) {
      const list = byProvider.get(entry.provider) ?? []
      if (!list.includes(entry.model)) list.push(entry.model)
      byProvider.set(entry.provider, list)
    }
    return Array.from(byProvider.entries()).map(([provider, models]) => ({ provider, models }))
  }, [effectiveAllowedModelsSpec])

  // Mount race: if the host loaded before the allowlist and it had NO saved
  // model, loadData resolved the draft to '' — seed the default once the
  // catalog arrives. Never overrides a non-empty draft (a saved model that
  // fell out of the allowlist stays selectable, spec R3.7). Cannot loop: it
  // only fires on an empty draft and always sets a non-empty value.
  useEffect(() => {
    if (providerDraft === 'codex-subscription') {
      const offered = constrainModelOptions(
        catalogForEditor,
        allowedModelsDraft,
        'codex-subscription'
      )
      const next = resolveCodexGrantModel(modelNameDraft, offered)
      if (next && next !== modelNameDraft) setModelNameDraft(next)
      return
    }
    if (modelNameDraft === '' && providerModelOptions.length > 0) {
      setModelNameDraft(resolveDefaultModel(providerDraft, providerModelOptions))
    }
  }, [allowedModelsDraft, catalogForEditor, modelNameDraft, providerDraft, providerModelOptions])

  useEffect(() => {
    setActiveTab(parseHostTab(params.tab))
  }, [params.tab])

  function hostTabHref(tab: HostTab): string {
    return CONTROL_ROUTES.agents.tab(routeName, TAB_SLUGS[tab])
  }

  function selectTab(tab: HostTab) {
    setActiveTab(tab)
    router.replace(hostTabHref(tab))
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadData(resetDrafts: 'all' | 'overview' | 'model' | 'none' = 'all') {
    setBusy(true)
    setInitialLoading(true)
    setError('')
    try {
      const detail = await getHostDetailBundle(routeName)
      const { host, contexts: contextsList, secrets: secretsList } = detail
      if (!mountedRef.current) return
      const spec = host.spec || {}
      // AP-6: remember the version of THIS read — the edit drafts below are
      // built from it, so it is the correct precondition for the eventual save.
      formResourceVersionRef.current = String(host.metadata?.resourceVersion || '')
      if (resetDrafts === 'all' || resetDrafts === 'overview') {
        // Snapshot the saved Overview state so Cancel/Edit can revert to it.
        const overview = {
          hostName: String(host.metadata?.name || routeName),
          hostDisplay: String(spec.host || host.metadata?.name || routeName),
          contextRef: String(spec.contextRef || ''),
          channels: Array.isArray(spec.channels) ? spec.channels.map(String).filter(Boolean) : [],
          stateless: spec.lifecycle?.stateless === true,
        }
        savedOverviewRef.current = overview
        setHostNameDraft(overview.hostName)
        setHostDisplayDraft(overview.hostDisplay)
        setContextRefDraft(overview.contextRef)
        setChannelsDraft(overview.channels)
        setStatelessDraft(overview.stateless)
      }
      const nextProvider = normalizeProvider(
        String((spec.model as { provider?: string } | undefined)?.provider || 'openai')
      )
      if (resetDrafts === 'all' || resetDrafts === 'model') {
        setProviderDraft(nextProvider)
        // Keep the host's saved model verbatim (preexisting resources are not
        // interrupted); only fall back to a default when the host has no model.
        const currentModel = String(
          (spec.model as { name?: string } | undefined)?.name || ''
        ).trim()
        setModelNameDraft(
          currentModel ||
            resolveDefaultModel(nextProvider, getModelOptions(allowedCatalog, nextProvider))
        )
        setConnectionRefDraft(
          String(
            (spec.model as { connectionRef?: string } | undefined)?.connectionRef || ''
          ).trim() || CODEX_UNASSIGNED_CONNECTION_KEY
        )
        setSecretRefDraft(String(spec.secretRef || ''))
        setLlmPolicyDraft(normalizeLlmPolicy(spec.llmPolicy))
        // Hydrate the per-host model subset from the saved spec (Topic 3a); absent
        // → [] = unrestricted (offers the full global allowlist per provider).
        setAllowedModelsDraft(normalizeAllowedModels(spec.allowedModels))
        // Write-only surfaces reset only when this tab is reloaded or saved.
        setLlmKeyDraft({})
        setRetireCandidates([])
      }
      const rawTools = (spec.approval as { tools?: Record<string, boolean> } | undefined)?.tools
      setApprovalToolsData(rawTools && typeof rawTools === 'object' ? rawTools : undefined)
      const rawGuardrails = spec.guardrails as HostGuardrails | undefined
      setGuardrailsData(
        rawGuardrails && typeof rawGuardrails === 'object' ? rawGuardrails : undefined
      )
      const specStateless = spec.lifecycle?.stateless === true
      setSavedStateless(specStateless)
      setLifecycleState(String(host.status?.lifecycle?.state ?? ''))
      setLifecycleReason(String(host.status?.lifecycle?.reason ?? ''))
      const rejection = (host.status?.conditions ?? []).find(
        condition => condition.type === 'StatelessEnableRejected' && condition.status === 'True'
      )
      setStatelessRejectionMessage(
        rejection
          ? String(
              rejection.message ||
                rejection.reason ||
                'Stateless mode was rejected by the platform.'
            )
          : ''
      )

      const contextIds = (contextsList || [])
        .map(item => String(item.spec?.contextId || item.metadata?.name || '').trim())
        .filter(Boolean)
      setAvailableContexts(Array.from(new Set(contextIds)).sort((a, b) => a.localeCompare(b)))
      const secretNames = (secretsList || []).map(item => item.name.trim()).filter(Boolean)
      setAvailableSecrets(Array.from(new Set(secretNames)).sort((a, b) => a.localeCompare(b)))

      // Map each Secret to its data-key NAMES (never values), already carried by
      // the detail bundle. Feeds the fallback credentialSlot dropdown's extra
      // keys (e.g. `claude-api-key-fb1`, spec R4.5.6) without a second fetch.
      const keysMap: Record<string, string[]> = {}
      for (const item of secretsList || []) {
        const name = item.name.trim()
        if (name) keysMap[name] = Array.isArray(item.keys) ? item.keys : []
      }
      setSecretKeysByName(keysMap)
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Failed to load agent details')
    } finally {
      if (mountedRef.current) {
        setBusy(false)
        setInitialLoading(false)
      }
    }
  }

  useEffect(() => {
    void loadData()
  }, [routeName])

  const currentSecretKeys = useMemo(
    () => secretKeysByName[secretRefDraft] ?? [],
    [secretKeysByName, secretRefDraft]
  )

  // Track fallback removals: when a fallback with its OWN stored extra slot is
  // dropped and no remaining entry references that key, offer to retire it
  // (spec Topic 1b R5). Re-adding a fallback that reclaims the key un-offers it.
  function handlePolicyChange(next: LlmPolicy | undefined) {
    const stored = new Set(currentSecretKeys)
    const stillInUse = getActiveCredentialKeys(providerDraft, next)
    const removedExtraSlots = (llmPolicyDraft?.fallbacks ?? [])
      .map(fallback => fallback.credentialSlot)
      .filter((slot): slot is string => Boolean(slot))
      .filter(slot => stored.has(slot) && !stillInUse.has(slot))
    setRetireCandidates(current => {
      const set = new Set(current)
      for (const slot of removedExtraSlots) set.add(slot)
      for (const slot of Array.from(set)) if (stillInUse.has(slot)) set.delete(slot)
      return Array.from(set)
    })
    setLlmPolicyDraft(next)
  }

  // Revert every Overview-owned draft to the last SAVED snapshot. Used by Cancel
  // and by Edit-open so an edit session always starts from server-backed values
  // — never a stale draft left behind by a prior discarded edit (any Overview
  // field, not just Display name: the whole class shares this reset).
  function resetOverviewDrafts() {
    const saved = savedOverviewRef.current
    setHostNameDraft(saved.hostName)
    setHostDisplayDraft(saved.hostDisplay)
    // contextRef is written by the Overview save (saveHost), so reset it here to
    // block a stale leak — EXCEPT while the Context tab has a live edit open: it
    // is a legitimate concurrent writer of contextRefDraft (its editingContext
    // session), and reverting an in-progress selection would silently discard it.
    if (!editingContext) setContextRefDraft(saved.contextRef)
    setChannelsDraft(saved.channels)
    setStatelessDraft(saved.stateless)
  }

  async function saveHost(): Promise<boolean> {
    const nextHostName = hostNameDraft.trim()
    if (!nextHostName) return false

    setBusy(true)
    setError('')
    try {
      // Re-fetch to preserve fields that aren't editable in this form. K8s
      // replaceNamespacedCustomObject is a full replace, not a merge.
      const currentHost = await getHost(routeName)
      const currentLifecycle = currentHost.spec?.lifecycle
      const currentWorkflowControl = currentHost.spec?.workflowControl
      // Overview owns only identity/shape fields (name, display, context,
      // channels, lifecycle). Model, secret, fallback policy and the per-host
      // model allowlist are owned by the "Model & credentials" tab and are
      // preserved here via the `...currentHost.spec` spread (full-replace
      // semantics — omitting them is what keeps them intact).
      const nextSpec: Record<string, unknown> = {
        ...currentHost.spec,
        host: hostDisplayDraft.trim() || nextHostName,
        contextRef: contextRefDraft.trim(),
        channels: channelsDraft,
        // Echo spec.lifecycle explicitly: the admin facade full-replaces the
        // spec, so leaving lifecycle implicit would strip the stateless flag.
        ...(statelessDraft || currentLifecycle
          ? { lifecycle: { ...currentLifecycle, stateless: statelessDraft } }
          : {}),
        ...(channelsDraft.length > 0 && currentWorkflowControl === undefined
          ? { workflowControl: { scopes: [...FIRST_PARTY_CHANNEL_WORKFLOW_CONTROL_SCOPES] } }
          : {}),
      }

      const formResourceVersion = formResourceVersionRef.current
      await apiSend('PUT', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`, {
        // AP-6: carry the resourceVersion captured at form load so the API
        // rejects this save with 409 {error:'conflict'} if the Host changed
        // while the operator was editing, instead of silently overwriting the
        // concurrent change with this form's stale echo.
        ...(formResourceVersion ? { metadata: { resourceVersion: formResourceVersion } } : {}),
        spec: nextSpec,
      })
      // Refresh server-backed state and this tab's saved values without
      // clobbering a still-open draft in "Model & credentials".
      await loadData('overview')
      showToast('Agent configuration saved.', { tone: 'success' })
      return true
    } catch (e) {
      const status = (e as { status?: number } | null)?.status
      const code = (e as { code?: string } | null)?.code
      if (status === 409 && code === 'conflict') {
        // AP-6 conflict: the Host changed between the form-load read and this
        // save. The resourceVersion precondition is whole-object (K8s has no
        // field-level precondition), so the true cause may be another operator's
        // edit OR the agent's own lifecycle machine ticking (HCC bumping
        // status.lifecycle / wake-requested on a stateless host). The 409 carries
        // no field diff, so the message must cover both causes without asserting
        // the wrong one — while keeping the reload + re-apply recovery.
        setError(
          "This agent changed since you opened the form (another edit, or the agent's own lifecycle state updated). Reload to see the latest, then re-apply your change."
        )
      } else {
        setError(e instanceof Error ? e.message : 'Failed to save agent')
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  // Scoped save for the "Model & credentials" tab. Owns provider/model,
  // secretRef, the opt-in fallback policy, the per-host model allowlist, and
  // write-only credential rotations/retirements. All other spec fields
  // (identity, context, channels, lifecycle) are preserved via the
  // `...currentHost.spec` spread (full-replace semantics).
  async function saveModelAndCredentials(): Promise<boolean> {
    const modelNameProblem = hostModelNameError(modelNameDraft)
    if (modelNameProblem) {
      setError(modelNameProblem)
      return false
    }
    // Client-side mirror of control-api's write gate (spec R5.3): block a save
    // with an out-of-allowlist fallback model before the round-trip. Skip the
    // check when the allowlist failed to load (`allowedCatalog` empty) — every
    // model would falsely flag as "not enabled"; the backend 422 stays the
    // source of truth for that case (matching how spec.model has no client gate).
    if (llmPolicyDraft && allowedCatalog.length > 0) {
      const policyErrors = validateLlmPolicy(llmPolicyDraft, allowedCatalog)
      if (policyErrors.length > 0) {
        setError(policyErrors[0])
        return false
      }
    }

    // The full allowlist validation above is skipped when the catalog failed to
    // load (`allowedCatalog` empty), which also skips the triggerOn check inside
    // `validateLlmPolicy`. An explicitly-empty `triggerOn` on a policy that HAS
    // fallbacks means "fail over on nothing" — the runtime silently disables
    // failover. Guard it here regardless of the catalog (least-surprising: block
    // rather than persist a policy that quietly no-ops), so the operator never
    // saves a self-disabled policy just because the allowlist was unavailable.
    if (
      llmPolicyDraft &&
      llmPolicyDraft.fallbacks.length > 0 &&
      Array.isArray(llmPolicyDraft.triggerOn) &&
      llmPolicyDraft.triggerOn.length === 0
    ) {
      setError(LLM_EMPTY_TRIGGER_ERROR)
      return false
    }

    // Asymmetric usable gate (spec Topic 1b): block save when the PRIMARY
    // provider isn't usable. "Usable" counts both a stored key (existingKeys)
    // and a freshly typed rotation, so switching to a provider whose key is
    // already stored stays allowed. Enforced only when we have real key signal —
    // the Secret listed at least one key OR the operator typed a rotation. An
    // empty/unlisted key set is treated as unknown (the backend stays the source
    // of truth), so the save is never blocked by stale listing.
    const chainRequiresSecret = llmChainRequiresSecret(providerDraft, llmPolicyDraft?.fallbacks)
    if (chainRequiresSecret && !secretRefDraft.trim()) {
      setError('Select an LLM secret for the static-credentials provider in this chain.')
      return false
    }
    const primaryPresent = (dataKey: string): boolean =>
      (llmKeyDraft[dataKey] ?? '').trim().length > 0 || currentSecretKeys.includes(dataKey)
    const typedAnyCredential = Object.values(llmKeyDraft).some(value => value.trim().length > 0)
    if (
      chainRequiresSecret &&
      secretRefDraft.trim() &&
      (currentSecretKeys.length > 0 || typedAnyCredential) &&
      !isProviderUsable(providerDraft, primaryPresent)
    ) {
      setError(`Add the ${getProviderLabel(providerDraft)} credential for the primary model.`)
      return false
    }

    // Write-only credential rotations + slot retirement (merge PUT, never a
    // full replace — a full replace of this shared Secret would drop fallback
    // keys the operator didn't re-type). The draft is PROJECTED onto the active
    // domain first, so a value typed for a since-unmounted provider (primary
    // switched, or a fallback removed) is neither validated nor written — no
    // stale block, no orphan key. Then validate cross-slot shape up front.
    const activeCredentialKeys = getActiveCredentialKeys(providerDraft, llmPolicyDraft)
    const rotatedData = projectCredentialDraft(llmKeyDraft, activeCredentialKeys)
    const removeKeys = retireCandidates.filter(key => !(key in rotatedData))
    // Cross-slot shape check on the rotated keys only. Note: rotating one half of
    // the Bedrock pair fails this (both must be written together) — matching the
    // server contract; the operator re-enters both to rotate either.
    const credentialSlotErrors = validateLlmSecretData(rotatedData)
    if (credentialSlotErrors.length > 0) {
      setError(credentialSlotErrors[0])
      return false
    }

    setBusy(true)
    setError('')
    try {
      // Re-fetch to preserve fields outside this tab's domain (full replace).
      const currentHost = await getHost(routeName)
      const nextSpec: Record<string, unknown> = {
        ...currentHost.spec,
        model: {
          provider: providerDraft,
          name: modelNameDraft.trim(),
          ...(providerDraft === 'codex-subscription'
            ? {
                connectionRef: connectionRefDraft.trim() || CODEX_UNASSIGNED_CONNECTION_KEY,
              }
            : {}),
        },
      }
      // Host identity is metadata.name / the route slug. Never persist
      // hostRef/userId as execution authority on this write.
      delete nextSpec.hostRef
      delete nextSpec.userId
      if (chainRequiresSecret) {
        nextSpec.secretRef = secretRefDraft.trim()
      } else {
        delete nextSpec.secretRef
      }
      // Opt-in fallback policy: set it when configured, otherwise drop it so a
      // Host with no policy stays exactly as today (full-replace semantics).
      if (llmPolicyDraft && llmPolicyDraft.fallbacks.length > 0) {
        nextSpec.llmPolicy = llmPolicyDraft
      } else {
        delete nextSpec.llmPolicy
      }
      // Per-host model allowlist subset (Topic 3a): emit only genuine subsets
      // (providers the operator restricted); drop the field entirely when every
      // provider is unrestricted so absent=all-global holds (full-replace
      // semantics — a Host that restricts nothing saves exactly as today).
      if (effectiveAllowedModelsSpec.length > 0) {
        nextSpec.allowedModels = effectiveAllowedModelsSpec
      } else {
        delete nextSpec.allowedModels
      }

      const formResourceVersion = formResourceVersionRef.current
      await apiSend('PUT', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`, {
        // AP-6: carry the resourceVersion captured at form load so the API
        // rejects this save with 409 {error:'conflict'} if the Host changed
        // while the operator was editing, instead of silently overwriting the
        // concurrent change with this form's stale echo.
        ...(formResourceVersion ? { metadata: { resourceVersion: formResourceVersion } } : {}),
        spec: nextSpec,
      })
      // Rotate/retire credentials on the Host's own Secret with merge:true so
      // other providers' stored keys are preserved (spec Topic 1b R5). removeKeys
      // retires the extra slots left behind by removed fallbacks.
      if (
        chainRequiresSecret &&
        secretRefDraft.trim() &&
        (Object.keys(rotatedData).length > 0 || removeKeys.length > 0)
      ) {
        await apiSend('PUT', '/api/v1/admin/secrets', {
          name: secretRefDraft.trim(),
          merge: true,
          ...(Object.keys(rotatedData).length > 0 ? { stringData: rotatedData } : {}),
          ...(removeKeys.length > 0 ? { removeKeys } : {}),
        })
      }
      // Refresh server-backed state and this tab's saved values without
      // clobbering a still-open Overview draft.
      await loadData('model')
      showToast('Model & credentials saved.', { tone: 'success' })
      return true
    } catch (e) {
      const status = (e as { status?: number } | null)?.status
      const code = (e as { code?: string } | null)?.code
      if (status === 409 && code === 'conflict') {
        // AP-6 conflict (see saveHost for full rationale): the Host changed
        // between the form-load read and this save. Reload to re-apply.
        setError(
          "This agent changed since you opened the form (another edit, or the agent's own lifecycle state updated). Reload to see the latest, then re-apply your change."
        )
      } else {
        setError(e instanceof Error ? e.message : 'Failed to save model & credentials')
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const persistApprovalTools = useCallback(
    async (tools: Record<string, boolean>) => {
      setBusy(true)
      setError('')
      try {
        const currentHost = await getHost(routeName)
        const currentApproval = (currentHost.spec?.approval as Record<string, unknown>) ?? {}
        const nextSpec = {
          ...currentHost.spec,
          approval: { ...currentApproval, tools },
        }
        await apiSend('PUT', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`, {
          spec: nextSpec,
        })
        // Reload approval/server state while preserving any drafts left open
        // in the Overview or Model tabs.
        await loadData('none')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save approval tools')
        // Re-throw so HostApprovalSection.handleSave does NOT exit edit mode
        // and the operator's draft is preserved alongside the error banner.
        throw e
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeName]
  )

  // Persist Host.spec.guardrails (hook references + built-ins). Owns only the
  // guardrails object — every other spec field is preserved via the
  // `...currentHost.spec` spread (full-replace semantics). Carries the
  // form-load resourceVersion so a concurrent change 409s instead of being
  // overwritten (AP-6), surfacing the same reload guidance as the other saves.
  const persistGuardrails = useCallback(
    async (next: HostGuardrails) => {
      setBusy(true)
      setError('')
      try {
        const currentHost = await getHost(routeName)
        const nextSpec = {
          ...currentHost.spec,
          guardrails: next,
        }
        const formResourceVersion = formResourceVersionRef.current
        await apiSend('PUT', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`, {
          ...(formResourceVersion ? { metadata: { resourceVersion: formResourceVersion } } : {}),
          spec: nextSpec,
        })
        // Reload guardrails/server state while preserving any drafts left open
        // in the Overview or Model tabs.
        await loadData('none')
        // No toast here on purpose: HostGuardrailsSection names the hook it
        // just changed once this resolves, and a generic 'saved' alongside it
        // would stack two success toasts on a single remove.
      } catch (e) {
        const status = (e as { status?: number } | null)?.status
        const code = (e as { code?: string } | null)?.code
        if (status === 409 && code === 'conflict') {
          setError(
            "This agent changed since you opened the form (another edit, or the agent's own lifecycle state updated). Reload to see the latest, then re-apply your change."
          )
        } else {
          setError(e instanceof Error ? e.message : 'Failed to save guardrails')
        }
        // Re-throw so HostGuardrailsSection knows the save failed and skips
        // its success toast, leaving the error/conflict banner to explain.
        throw e
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeName]
  )

  async function deleteAgentPermanently() {
    setDeletingAgent(true)
    setDeleteAgentDialogError('')
    setError('')
    try {
      await apiSend('DELETE', `/api/v1/admin/hosts/${encodeURIComponent(routeName)}`)
      setShowDeleteAgentConfirm(false)
      showToast(`Agent ${routeName} deleted.`, { tone: 'success' })
      router.push(CONTROL_ROUTES.agents.root)
    } catch (e) {
      setDeleteAgentDialogError(e instanceof Error ? e.message : 'Failed to delete agent')
    } finally {
      setDeletingAgent(false)
    }
  }

  return (
    <DetailPageShell<HostTab>
      activeTab={activeTab}
      backLabel="Back to agents"
      error={error}
      icon={<IconRobot />}
      onBack={() => router.push(CONTROL_ROUTES.agents.root)}
      onTabChange={selectTab}
      subtitle="Configuration and access for this agent."
      tabAriaLabel="Agent sections"
      tabClassName="cu-tabs--compact"
      contentClassName={
        activeTab === 'advanced' || (activeTab === 'model' && editingModel)
          ? 'cu-agent-detail-card'
          : undefined
      }
      tabs={HOST_TABS.map(tab => ({
        value: tab,
        label: TAB_LABELS[tab],
        href: hostTabHref(tab),
      }))}
      title={`Agent: ${routeName}`}
    >
      <div className="cu-agent-detail-scroll">
        {activeTab === 'details' && (
          <>
            {statelessRejectionMessage ? (
              <div className="cu-banner cu-banner--warning" style={{ marginBottom: '1rem' }}>
                <strong>Stateless mode rejected:</strong> {statelessRejectionMessage}
              </div>
            ) : null}
            <div className="cu-agent-detail-heading">
              <div
                style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}
              >
                <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
                  Agent configuration and settings.
                </p>
                {savedStateless && lifecycleState ? (
                  <span className="cu-chip">
                    {`Lifecycle: ${lifecycleState}${
                      lifecycleReason ? ` — ${friendlyLifecycleReason(lifecycleReason)}` : ''
                    }`}
                  </span>
                ) : null}
              </div>
              <div className="cu-agent-detail-heading__actions">
                {editingOverview ? (
                  <>
                    <button
                      type="button"
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      onClick={() => {
                        // Discard any unsaved Overview edits before leaving edit
                        // mode, so the read-only view and the next save reflect
                        // the last SAVED state — not the abandoned draft.
                        resetOverviewDrafts()
                        setEditingOverview(false)
                      }}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="cu-btn cu-btn--primary"
                      onClick={async () => {
                        // AP-6: stay in edit mode on failure so the operator's
                        // draft survives alongside the error/conflict banner.
                        if (await saveHost()) {
                          setEditingOverview(false)
                        }
                      }}
                      disabled={busy || !hostNameDraft.trim()}
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost cu-btn--sm"
                    onClick={() => {
                      // Defensive: start every edit session from the last SAVED
                      // snapshot, so a stale draft never leaks into this Overview
                      // save. resetOverviewDrafts deliberately leaves contextRef
                      // untouched while the Context tab is mid-edit — that tab is a
                      // legitimate live writer of contextRefDraft, not a stale
                      // leftover, so its in-progress selection must be preserved.
                      resetOverviewDrafts()
                      setEditingOverview(true)
                    }}
                    disabled={busy}
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>
            <div className="cu-form-stack">
              <div className="cu-field">
                <label htmlFor="host-name">Name</label>
                {editingOverview ? (
                  <>
                    <input id="host-name" value={hostNameDraft} readOnly />
                    <span className="cu-field__hint">
                      This is the agent identifier, not editable.
                    </span>
                  </>
                ) : (
                  <div className="cu-field__readonly">{hostNameDraft}</div>
                )}
              </div>
              <div className="cu-field">
                <label htmlFor="host-display">Display name</label>
                {editingOverview ? (
                  <input
                    id="host-display"
                    value={hostDisplayDraft}
                    onChange={e => setHostDisplayDraft(e.target.value)}
                    disabled={busy}
                    autoFocus
                  />
                ) : (
                  <div className="cu-field__readonly">{hostDisplayDraft}</div>
                )}
              </div>
              <div className="cu-field" style={{ marginBottom: 0 }}>
                <label htmlFor="host-agent-type">Type</label>
                {editingOverview ? (
                  <>
                    <select
                      id="host-agent-type"
                      value={statelessDraft ? 'stateless' : 'stateful'}
                      onChange={e => setStatelessDraft(e.target.value === 'stateless')}
                      disabled={busy}
                    >
                      <option value="stateful">Stateful (always on)</option>
                      <option value="stateless">Stateless (suspends when idle)</option>
                    </select>
                    <span className="cu-field__hint">
                      Stateless agents suspend after the idle window and wake on demand.
                      Communication channels keep stateless agents always-on unless the cluster
                      explicitly enables wake-on-interaction; desktop still requires a stateful
                      agent.
                    </span>
                  </>
                ) : (
                  <div className="cu-field__readonly">
                    {statelessDraft ? 'Stateless (suspends when idle)' : 'Stateful (always on)'}
                  </div>
                )}
              </div>
            </div>

            {!initialLoading && (
              <div
                style={{
                  marginTop: '2rem',
                  paddingTop: '1.25rem',
                  borderTop: '1px solid var(--cu-border)',
                }}
              >
                <p className="cu-section-title" style={{ marginBottom: '0.5rem' }}>
                  Danger zone
                </p>
                <p className="cu-muted" style={{ fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
                  Permanently delete this agent and its direct access mappings.
                </p>
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  style={{ color: 'var(--cu-danger)' }}
                  onClick={() => {
                    setDeleteAgentDialogError('')
                    setShowDeleteAgentConfirm(true)
                  }}
                  disabled={busy}
                >
                  Delete agent...
                </button>
              </div>
            )}
          </>
        )}

        {activeTab === 'model' && (
          <>
            <div className={editingModel ? 'cu-agent-detail-toolbar' : 'cu-agent-detail-heading'}>
              <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
                Provider, allowed models, fallback policy, and credentials for this agent.
              </p>
              <div
                className={
                  editingModel
                    ? 'cu-agent-detail-toolbar__actions'
                    : 'cu-agent-detail-heading__actions'
                }
              >
                {editingModel ? (
                  <>
                    <button
                      type="button"
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      onClick={() => setEditingModel(false)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="cu-btn cu-btn--primary"
                      onClick={async () => {
                        // AP-6: stay in edit mode on failure so the operator's
                        // draft survives alongside the error/conflict banner.
                        if (await saveModelAndCredentials()) {
                          setEditingModel(false)
                        }
                      }}
                      disabled={busy || Boolean(hostModelNameError(modelNameDraft))}
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost cu-btn--sm"
                    onClick={() => setEditingModel(true)}
                    disabled={busy}
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>

            {!editingModel ? (
              <div className="cu-form-stack">
                <div className="cu-field">
                  <label htmlFor="model-provider">Model provider</label>
                  <div className="cu-field__readonly">{getProviderLabel(providerDraft)}</div>
                </div>
                {isOpenAiFamily(providerDraft) ? (
                  <div className="cu-field">
                    <label htmlFor="model-openai-credential">OpenAI credential</label>
                    <div className="cu-field__readonly">
                      {providerDraft === 'codex-subscription' ? 'ChatGPT subscription' : 'API key'}
                    </div>
                  </div>
                ) : null}
                {providerDraft === 'codex-subscription' ? (
                  <div className="cu-field">
                    <label htmlFor="model-subscription">Subscription</label>
                    <div className="cu-field__readonly">
                      {connectionRefDraft === CODEX_UNASSIGNED_CONNECTION_KEY
                        ? 'No subscription assigned'
                        : connectionRefDraft}
                    </div>
                  </div>
                ) : null}
                <div className="cu-field">
                  <label htmlFor="model-allowed">Allowed models</label>
                  {allowedModelsSummary.length > 0 ? (
                    <ul className="cu-llm-policy__summary">
                      {allowedModelsSummary.map(entry => (
                        <li key={entry.provider} className="cu-field__readonly">
                          {getProviderLabel(entry.provider)} · {entry.models.join(', ')}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="cu-field__readonly">
                      All models — this agent offers every enabled model for its provider(s).
                    </div>
                  )}
                </div>
                {llmChainRequiresSecret(providerDraft, llmPolicyDraft?.fallbacks) ? (
                  <div className="cu-field">
                    <label htmlFor="model-secret">Secret reference</label>
                    <div className="cu-field__readonly">{secretRefDraft || '-'}</div>
                  </div>
                ) : (
                  <div className="cu-field">
                    <label htmlFor="model-secret">Secret reference</label>
                    <div className="cu-field__readonly">Broker-backed — no LLM secret required</div>
                  </div>
                )}
                <div className="cu-field">
                  <label htmlFor="model-fallback">Fallback policy</label>
                  {llmPolicyDraft && llmPolicyDraft.fallbacks.length > 0 ? (
                    <ol className="cu-llm-policy__summary">
                      {llmPolicyDraft.fallbacks.map((entry, index) => (
                        <li key={index} className="cu-field__readonly">
                          {getProviderLabel(entry.provider)} · {entry.model || '-'}
                          {entry.credentialSlot ? ` · ${entry.credentialSlot}` : ''}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="cu-field__readonly">No fallback configured.</div>
                  )}
                </div>
              </div>
            ) : (
              <>
                {retireCandidates.length > 0 ? (
                  <div className="cu-banner cu-banner--warning" style={{ marginBottom: '0.75rem' }}>
                    <span>
                      Removed fallback left stored key(s): {retireCandidates.join(', ')}. They will
                      be deleted from the Secret when you save.
                    </span>
                    <button
                      type="button"
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      onClick={() => setRetireCandidates([])}
                      disabled={busy}
                    >
                      Keep them
                    </button>
                  </div>
                ) : null}
                {llmChainRequiresSecret(providerDraft, llmPolicyDraft?.fallbacks) ? (
                  <div className="cu-form-stack" style={{ marginBottom: '1rem' }}>
                    <div className="cu-field">
                      <label htmlFor="host-secret">Secret reference</label>
                      <select
                        id="host-secret"
                        value={secretRefDraft}
                        onChange={e => setSecretRefDraft(e.target.value)}
                        disabled={busy}
                      >
                        <option value="">Select LLM secret</option>
                        {availableSecrets.map(secretName => (
                          <option key={secretName} value={secretName}>
                            {secretName}
                          </option>
                        ))}
                        {secretRefDraft && !availableSecrets.includes(secretRefDraft) ? (
                          <option value={secretRefDraft}>{secretRefDraft} (custom)</option>
                        ) : null}
                      </select>
                    </div>
                  </div>
                ) : null}
                <LlmProviderConfig
                  provider={providerDraft}
                  model={modelNameDraft}
                  subscriptionCredentialEnabled
                  afterPrimaryProvider={
                    providerDraft === 'codex-subscription' ? (
                      <CodexAgentAssignment
                        connectionRef={connectionRefDraft}
                        hostName={routeName}
                        onConnectionRefChange={setConnectionRefDraft}
                        onModelsChange={setCodexModels}
                        disabled={busy}
                      />
                    ) : null
                  }
                  onPrimaryChange={next => {
                    setProviderDraft(next.provider)
                    setModelNameDraft(next.model)
                  }}
                  policy={llmPolicyDraft}
                  onPolicyChange={handlePolicyChange}
                  allowedModels={allowedModelsDraft}
                  onAllowedModelsChange={setAllowedModelsDraft}
                  catalog={catalogForEditor}
                  catalogLoading={modelsLoading}
                  catalogError={modelsError}
                  replacePrimaryModelWithAllowedModels={providerDraft !== 'codex-subscription'}
                  credentials={
                    llmChainRequiresSecret(providerDraft, llmPolicyDraft?.fallbacks)
                      ? {
                          draft: llmKeyDraft,
                          onChange: (dataKey, value) =>
                            setLlmKeyDraft(prev => ({ ...prev, [dataKey]: value })),
                          existingKeys: currentSecretKeys,
                        }
                      : undefined
                  }
                  secretKeys={
                    llmChainRequiresSecret(providerDraft, llmPolicyDraft?.fallbacks)
                      ? currentSecretKeys
                      : []
                  }
                  disabled={busy}
                />
              </>
            )}
          </>
        )}

        {activeTab === 'advanced' && (
          <HostAdvancedTab
            busy={busy}
            hostName={routeName}
            initialGuardrails={guardrailsData}
            initialLoading={initialLoading}
            initialTools={approvalToolsData}
            onSaveApprovalTools={persistApprovalTools}
            onSaveGuardrails={persistGuardrails}
          />
        )}

        {activeTab === 'contexts' && (
          <>
            <p className="cu-muted" style={{ fontSize: '0.875rem', marginBottom: '1rem' }}>
              Associated context for this agent.
            </p>
            <div className="cu-table-wrap">
              <table className="cu-table cu-table--header-band cu-table--static-rows">
                <thead>
                  <tr>
                    <th>Context</th>
                    <th className="cu-table__col-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {initialLoading ? (
                    <tr>
                      <td colSpan={2} className="cu-empty">
                        Loading…
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td>
                        {editingContext ? (
                          <select
                            className="cu-input cu-host-context-select"
                            value={contextRefDraft}
                            onChange={e => setContextRefDraft(e.target.value)}
                            disabled={busy}
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === 'Escape') {
                                setEditingContext(false)
                              }
                            }}
                          >
                            <option value="">Select context</option>
                            {availableContexts.map(contextId => (
                              <option key={contextId} value={contextId}>
                                {contextId}
                              </option>
                            ))}
                          </select>
                        ) : contextRefDraft.trim() ? (
                          <button
                            type="button"
                            className="cu-link"
                            onClick={() =>
                              router.push(CONTROL_ROUTES.contexts.detail(contextRefDraft.trim()))
                            }
                          >
                            {contextRefDraft}
                          </button>
                        ) : (
                          <span className="cu-table__cell-muted">No context selected</span>
                        )}
                      </td>
                      <td className="cu-table__cell-actions">
                        {editingContext ? (
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--toolbar"
                            onClick={async () => {
                              if (await saveHost()) {
                                setEditingContext(false)
                              }
                            }}
                            disabled={busy}
                            aria-label="Save context"
                            title="Save context"
                          >
                            <IconCheck width={16} height={16} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--toolbar"
                            onClick={() => setEditingContext(true)}
                            disabled={busy}
                            aria-label="Edit context"
                            title="Edit context"
                          >
                            <IconPencil width={16} height={16} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'identity' && <HostIdentityTab hostName={routeName} />}

        {activeTab === 'access' && <HostAccessTab hostName={routeName} />}
      </div>
      {showDeleteAgentConfirm && (
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
            if (e.target === e.currentTarget && !deletingAgent) setShowDeleteAgentConfirm(false)
          }}
        >
          <div
            className="cu-modal-panel"
            style={{ width: 'min(28rem, 96vw)' }}
            role="alertdialog"
            aria-labelledby="confirm-delete-agent"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="confirm-delete-agent" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Delete agent permanently?
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowDeleteAgentConfirm(false)}
                disabled={deletingAgent}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>
            <p className="cu-muted" style={{ fontSize: '0.875rem', margin: '0 0 1rem' }}>
              This removes <strong>{routeName}</strong> and cannot be undone.
            </p>
            {deleteAgentDialogError ? (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '0.75rem' }}>
                {deleteAgentDialogError}
              </div>
            ) : null}
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowDeleteAgentConfirm(false)}
                disabled={deletingAgent}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                style={{ background: 'var(--cu-danger)', borderColor: 'var(--cu-danger)' }}
                onClick={() => void deleteAgentPermanently()}
                disabled={deletingAgent}
              >
                {deletingAgent ? 'Deleting…' : 'Delete agent'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </DetailPageShell>
  )
}
