'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DetailPageShell } from '@components/DetailPageShell'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { useToast } from '@components/Toast'
import { HOST_DEFAULT_TAB, HOST_TABS } from '@constants/hostDetails'
import { CONTROL_ROUTES } from '@constants/routes'
import { HostAccessTab } from '../../../components/HostAccessTab'
import { HostAdvancedTab } from '../../../components/HostAdvancedTab'
import type { HostGuardrails } from '../../../components/HostGuardrailsSection/types'
import { HostIdentityTab } from '../../../components/HostIdentityTab'
import { HostOverviewTab } from '../../../components/HostOverviewTab'
import { LlmCredentialFields } from '../../../components/LlmCredentialFields'
import { LlmProviderConfig } from '../../../components/LlmProviderConfig'
import { RowActionsMenu } from '../../../components/RowActionsMenu'
import { IconRobot } from '../../../components/Sidebar/icons'
import { IconCheck, IconMoreHorizontal, IconPencil, IconX } from '../../../components/icons'
import {
  apiSend,
  getHost,
  getHostDetailBundle,
  getMcpServers,
  updateContext,
} from '../../../lib/api'
import type { ContextResource, ContextSpec } from '../../../lib/api'
import { buildContextUpdatePayload, contextMutationError } from '../../../lib/contextMutation'
import { useLlmAllowedModels } from '../../../lib/hooks/useLlmAllowedModels'
import { FIRST_PARTY_CHANNEL_WORKFLOW_CONTROL_SCOPES } from '../../../lib/hostWorkflowControl'
import {
  type HostAllowedModel,
  LLM_EMPTY_TRIGGER_ERROR,
  type LlmPolicy,
  type LlmProvider,
  buildAllowedModelsSpec,
  getActiveCredentialKeys,
  getModelOptions,
  getProviderLabel,
  isProviderUsable,
  normalizeAllowedModels,
  normalizeLlmPolicy,
  normalizeProvider,
  projectCredentialDraft,
  providerForDataKey,
  resolveDefaultModel,
  validateLlmPolicy,
  validateLlmSecretData,
} from '../../../lib/llm'
import type { HostTab } from './types'

const TAB_LABELS: Record<HostTab, string> = {
  details: 'Overview',
  model: 'Models & creds',
  advanced: 'Advanced',
  connectors: 'Connectors',
  access: 'Access',
  identity: 'Identity',
}

const TAB_SLUGS: Record<HostTab, string> = {
  details: 'overview',
  model: 'model',
  advanced: 'advanced',
  connectors: 'connectors',
  access: 'access',
  identity: 'identity',
}

function parseHostTab(value: string | undefined): HostTab {
  return HOST_TABS.find(tab => TAB_SLUGS[tab] === value) ?? HOST_DEFAULT_TAB
}

// Format an RFC3339 timestamp (or empty) to the table-style "May 21, 2024 • 10:24 AM"
// used in the Overview identity card. Empty string falls through to the same so the
// cell shows a dash and we don't render "Invalid Date".
function formatTimestamp(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const month = date.toLocaleString('en-US', { month: 'long' })
  const day = date.getDate()
  const year = date.getFullYear()
  let hours = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const meridiem = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  return `${month} ${day}, ${year} • ${hours}:${minutes} ${meridiem}`
}

// Cron×stateless: map the machine-readable suspend-blocked reason to
// operator-friendly text. Every other reason renders verbatim.
function friendlyLifecycleReason(reason: string): string {
  if (reason === 'SuspendBlocked: activeCronSchedules') {
    return 'Not suspending: active scheduled tasks keep this agent awake'
  }
  return reason
}

function contextResourceName(context: ContextResource | null): string {
  return String(context?.metadata?.name || context?.spec?.contextId || '').trim()
}

function normalizeConnectorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .map(String)
        .map(name => name.trim())
        .filter(Boolean)
    )
  )
}

function agentConnectorMutationError(error: unknown): string {
  if ((error as { status?: unknown } | null)?.status === 409) {
    return 'This agent’s connectors changed since they were loaded. Reload the agent and try again.'
  }
  if (error instanceof Error && /context version is unavailable/i.test(error.message)) {
    return 'This agent’s connector settings are missing a server version. Reload the agent and try again.'
  }
  return contextMutationError(error, 'Failed to update connectors for this agent.')
}

function AgentActionsMenu({ busy, onDelete }: { busy: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleDocClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  return (
    <div ref={ref} className="cu-kebab">
      <button
        type="button"
        aria-label="Agent actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--icon cu-btn--ghost cu-kebab__trigger"
        onClick={() => setOpen(value => !value)}
        disabled={busy}
      >
        <IconMoreHorizontal width={16} height={16} />
      </button>
      {open ? (
        <div role="menu" className="cu-kebab__menu">
          <button
            type="button"
            role="menuitem"
            className="cu-kebab__item cu-kebab__item--danger"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Delete agent
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default function HostDetailsPage() {
  const params = useParams<{ name: string; tab?: string }>()
  const router = useRouter()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()

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
  const [hostDescription, setHostDescription] = useState('')
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
  const [additionalRetireCandidates, setAdditionalRetireCandidates] = useState<string[]>([])
  // Data keys present per LLM Secret name, so the fallback credentialSlot
  // dropdown can offer extra keys (e.g. `claude-api-key-fb1`) — never free text.
  const [secretKeysByName, setSecretKeysByName] = useState<Record<string, string[]>>({})
  const [channelsDraft, setChannelsDraft] = useState<string[]>([])
  const [approvalToolsData, setApprovalToolsData] = useState<Record<string, boolean> | undefined>(
    undefined
  )
  const [guardrailsData, setGuardrailsData] = useState<HostGuardrails | undefined>(undefined)
  // Overview tab — read-only summary. Kept in sync with the host spec by loadData.
  const [contextMcpServers, setContextMcpServers] = useState<string[]>([])
  // The agent's private connector context is an implementation detail. Keep the
  // full resource locally so connector writes can preserve additive spec fields
  // and carry the resourceVersion without exposing the context in the UI.
  const [agentContext, setAgentContext] = useState<ContextResource | null>(null)
  const [availableConnectorNames, setAvailableConnectorNames] = useState<string[]>([])
  const [connectorCatalogLoaded, setConnectorCatalogLoaded] = useState(false)
  const [connectorCatalogLoading, setConnectorCatalogLoading] = useState(false)
  const [showAddConnector, setShowAddConnector] = useState(false)
  const [selectedConnectorNames, setSelectedConnectorNames] = useState<string[]>([])
  const [hostStatusLabel, setHostStatusLabel] = useState('Unknown')
  const [hostStatusTone, setHostStatusTone] = useState<'active' | 'inactive' | 'unknown'>('unknown')
  const [hostCreatedAt, setHostCreatedAt] = useState('')
  const [hostLastUpdated, setHostLastUpdated] = useState('')
  const [hostUid, setHostUid] = useState('')
  const [accessSummary, setAccessSummary] = useState<{
    memberCount: number
    teamCount: number
    memberNames: string[]
    teamNames: string[]
  }>({ memberCount: 0, teamCount: 0, memberNames: [], teamNames: [] })
  const [statelessDraft, setStatelessDraft] = useState(false)
  const [savedStateless, setSavedStateless] = useState(false)
  const [lifecycleState, setLifecycleState] = useState('')
  const [lifecycleReason, setLifecycleReason] = useState('')
  const [statelessRejectionMessage, setStatelessRejectionMessage] = useState('')

  const [availableContexts, setAvailableContexts] = useState<string[]>([])
  const [availableSecrets, setAvailableSecrets] = useState<string[]>([])

  const providerModelOptions = useMemo(
    () => getModelOptions(allowedCatalog, providerDraft),
    [allowedCatalog, providerDraft]
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
    if (modelNameDraft === '' && providerModelOptions.length > 0) {
      setModelNameDraft(resolveDefaultModel(providerDraft, providerModelOptions))
    }
  }, [modelNameDraft, providerDraft, providerModelOptions])

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
      const { host, contexts: contextsList, secrets: secretsList, agentUsers, agentTeams } = detail
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
        setHostDescription(String(spec.description || '').trim())
        setContextRefDraft(overview.contextRef)
        setChannelsDraft(overview.channels)
        setStatelessDraft(overview.stateless)
        // Overview read-only summary: linked context's MCP servers + access counts.
        const ref = overview.contextRef.trim()
        const matched = (contextsList || []).find(
          item => String(item.spec?.contextId || item.metadata?.name || '').trim() === ref
        ) as ContextResource | undefined
        setAgentContext(matched ?? null)
        const servers = normalizeConnectorNames(matched?.spec?.mcpServers)
        setContextMcpServers(servers)
        setAccessSummary({
          memberCount: Array.isArray(agentUsers) ? agentUsers.length : 0,
          teamCount: Array.isArray(agentTeams) ? agentTeams.length : 0,
          memberNames: Array.isArray(agentUsers)
            ? (
                agentUsers as Array<{
                  displayName?: string | null
                  name?: string | null
                  email?: string
                }>
              )
                .map(item => String(item.displayName || item.name || item.email || '').trim())
                .filter(Boolean)
            : [],
          teamNames: Array.isArray(agentTeams)
            ? (agentTeams as Array<{ name?: string }>)
                .map(item => String(item.name || '').trim())
                .filter(Boolean)
            : [],
        })
        // Overview read-only: status, created/updated timestamps, UID.
        // K8s carries lifecycle.state on status. Map active/suspended/etc. to a
        // simple active/inactive/unknown tone for the badge.
        const lifecycleState = String(
          (host.status as { lifecycle?: { state?: string } } | undefined)?.lifecycle?.state || ''
        ).trim()
        const lowerState = lifecycleState.toLowerCase()
        if (lowerState === 'active' || lowerState === 'ready') {
          setHostStatusLabel('Active')
          setHostStatusTone('active')
        } else if (lowerState === 'blocked' || lowerState === 'failed') {
          setHostStatusLabel(lifecycleState || 'Inactive')
          setHostStatusTone('inactive')
        } else if (lifecycleState) {
          setHostStatusLabel(lifecycleState)
          setHostStatusTone('unknown')
        } else {
          setHostStatusLabel('Active')
          setHostStatusTone('active')
        }
        const createdAt = String(host.metadata?.creationTimestamp || '').trim()
        setHostCreatedAt(formatTimestamp(createdAt))
        setHostLastUpdated(formatTimestamp(createdAt))
        setHostUid(String(host.metadata?.uid || '').trim())
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
        setSecretRefDraft(String(spec.secretRef || ''))
        setLlmPolicyDraft(normalizeLlmPolicy(spec.llmPolicy))
        // Hydrate the per-host model subset from the saved spec (Topic 3a); absent
        // → [] = unrestricted (offers the full global allowlist per provider).
        setAllowedModelsDraft(normalizeAllowedModels(spec.allowedModels))
        // Write-only surfaces reset only when this tab is reloaded or saved.
        setLlmKeyDraft({})
        setRetireCandidates([])
        setAdditionalRetireCandidates([])
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

  async function openAddConnectorDialog() {
    setSelectedConnectorNames([])
    setShowAddConnector(true)
    setError('')
    if (connectorCatalogLoaded || connectorCatalogLoading) return

    setConnectorCatalogLoading(true)
    try {
      const response = await getMcpServers()
      const names = (response.items || [])
        .map(item => String(item.metadata?.name || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
      setAvailableConnectorNames(Array.from(new Set(names)))
      setConnectorCatalogLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load available connectors.')
    } finally {
      setConnectorCatalogLoading(false)
    }
  }

  async function saveAgentConnectors(nextServers: string[]): Promise<boolean> {
    const contextName = contextResourceName(agentContext)
    const contextVersion = agentContext?.metadata?.resourceVersion
    if (!contextName) {
      setError(
        'Connector settings are not available for this agent yet. Reload the agent and try again.'
      )
      return false
    }

    const normalizedServers = normalizeConnectorNames(nextServers)
    const currentSpec = (agentContext?.spec || {}) as Record<string, unknown>
    const contextId = String(currentSpec.contextId || contextName).trim()
    if (!contextId) {
      setError(
        'Connector settings are not available for this agent yet. Reload the agent and try again.'
      )
      return false
    }

    setBusy(true)
    setError('')
    try {
      const updated = await updateContext(
        contextName,
        buildContextUpdatePayload(contextVersion, {
          ...currentSpec,
          contextId,
          mcpServers: normalizedServers,
        } as ContextSpec)
      )
      const updatedContext: ContextResource = {
        ...agentContext,
        ...updated,
        metadata: { ...agentContext.metadata, ...(updated?.metadata || {}) },
        spec: {
          ...agentContext.spec,
          ...(updated?.spec || {}),
          contextId,
          mcpServers: normalizedServers,
        },
      }
      setAgentContext(updatedContext)
      setContextMcpServers(normalizedServers)
      showToast('Connectors updated.', { tone: 'success' })
      return true
    } catch (e) {
      setError(agentConnectorMutationError(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function removeAgentConnector(server: string) {
    const shouldRemove = await confirm({
      title: 'Remove connector from this agent?',
      message: `Remove ${server} from ${routeName}?`,
      confirmLabel: 'Remove connector',
      tone: 'danger',
    })
    if (!shouldRemove) return
    await saveAgentConnectors(contextMcpServers.filter(item => item !== server))
  }

  const currentSecretKeys = useMemo(
    () => secretKeysByName[secretRefDraft] ?? [],
    [secretKeysByName, secretRefDraft]
  )

  const activeCredentialProviders = useMemo(() => {
    const providers = new Set<LlmProvider>([
      providerDraft,
      ...(llmPolicyDraft?.fallbacks ?? []).map(fallback => fallback.provider),
    ])
    return providers
  }, [llmPolicyDraft, providerDraft])

  // The host runtime still selects credentials through the primary/fallback
  // provider domain. Other provider keys can safely live in the same Secret,
  // but they are intentionally shown in a separate additive editor until the
  // operator selects one as a primary or fallback provider.
  const additionalCredentialKeys = useMemo(
    () =>
      currentSecretKeys.filter(key => {
        const owner = providerForDataKey(key)
        return owner !== null && !activeCredentialProviders.has(owner)
      }),
    [activeCredentialProviders, currentSecretKeys]
  )
  const additionalCredentialDraft = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(llmKeyDraft).filter(([key, value]) => {
          const owner = providerForDataKey(key)
          return owner !== null && !activeCredentialProviders.has(owner) && value.trim().length > 0
        })
      ),
    [activeCredentialProviders, llmKeyDraft]
  )
  const credentialSetProviders = useMemo(() => {
    const providers = new Set<LlmProvider>()
    for (const key of currentSecretKeys) {
      const owner = providerForDataKey(key)
      if (owner) providers.add(owner)
    }
    return Array.from(providers)
      .map(provider => ({
        provider,
        usable: isProviderUsable(provider, key => currentSecretKeys.includes(key)),
      }))
      .sort((left, right) =>
        getProviderLabel(left.provider).localeCompare(getProviderLabel(right.provider))
      )
  }, [currentSecretKeys])
  const credentialSetOptions = useMemo(() => {
    const options = availableSecrets.map(secretName => {
      const providers = new Set<LlmProvider>()
      for (const key of secretKeysByName[secretName] ?? []) {
        const owner = providerForDataKey(key)
        if (owner) providers.add(owner)
      }
      const providerNames = Array.from(providers)
        .map(getProviderLabel)
        .sort((left, right) => left.localeCompare(right))
      return {
        value: secretName,
        label: secretName,
        description:
          providerNames.length > 0
            ? `${providerNames.join(', ')} available`
            : 'No recognized provider credentials yet',
      }
    })
    if (secretRefDraft && !availableSecrets.includes(secretRefDraft)) {
      options.push({
        value: secretRefDraft,
        label: secretRefDraft,
        description: 'Selected LLM Secret (details unavailable)',
      })
    }
    return options
  }, [availableSecrets, secretKeysByName, secretRefDraft])
  const pendingCredentialRemovals = useMemo(
    () => Array.from(new Set([...retireCandidates, ...additionalRetireCandidates])),
    [additionalRetireCandidates, retireCandidates]
  )

  const connectorOptions = useMemo(
    () =>
      availableConnectorNames
        .filter(name => !contextMcpServers.includes(name))
        .map(name => ({ value: name, label: name })),
    [availableConnectorNames, contextMcpServers]
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

  async function saveHost(nextDisplayName = hostDisplayDraft): Promise<boolean> {
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
        host: nextDisplayName.trim() || nextHostName,
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
    const primaryPresent = (dataKey: string): boolean =>
      (llmKeyDraft[dataKey] ?? '').trim().length > 0 || currentSecretKeys.includes(dataKey)
    const typedAnyCredential = Object.values(llmKeyDraft).some(value => value.trim().length > 0)
    if (
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
    // Additive provider editing intentionally extends the active routing domain:
    // a provider added to this LLM Secret is persisted now and becomes
    // available for primary/fallback selection without another secret flow.
    const credentialKeysToWrite = new Set(activeCredentialKeys)
    for (const key of Object.keys(llmKeyDraft)) {
      const owner = providerForDataKey(key)
      if (owner && !activeCredentialProviders.has(owner)) credentialKeysToWrite.add(key)
    }
    const rotatedData = projectCredentialDraft(llmKeyDraft, credentialKeysToWrite)
    const removeKeys = pendingCredentialRemovals.filter(key => !(key in rotatedData))
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
        secretRef: secretRefDraft.trim(),
        model: {
          provider: providerDraft,
          name: modelNameDraft.trim(),
        },
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
      if (secretRefDraft.trim() && (Object.keys(rotatedData).length > 0 || removeKeys.length > 0)) {
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
      titleActions={
        <AgentActionsMenu
          busy={busy || deletingAgent}
          onDelete={() => {
            setDeleteAgentDialogError('')
            setShowDeleteAgentConfirm(true)
          }}
        />
      }
    >
      <div className="cu-agent-detail-scroll">
        {activeTab === 'details' && (
          <HostOverviewTab
            hostName={routeName}
            displayName={hostDisplayDraft}
            description={hostDescription}
            statusLabel={hostStatusLabel}
            statusTone={hostStatusTone}
            contextRef={contextRefDraft}
            contextMcpServers={contextMcpServers}
            contextMcpTotal={contextMcpServers.length}
            modelPrimary={modelNameDraft}
            modelProviderLine={
              modelNameDraft ? `${getProviderLabel(providerDraft)} · ${modelNameDraft}` : ''
            }
            accessSummary={accessSummary}
            onNavigate={tab => selectTab(tab)}
            onSaveDisplayName={nextDisplayName => saveHost(nextDisplayName)}
            createdAt={hostCreatedAt}
            lastUpdated={hostLastUpdated}
          />
        )}

        {activeTab === 'model' && (
          <>
            <div className="cu-agent-detail-heading">
              <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
                Provider, allowed models, fallback policy, and credentials for this agent.
              </p>
              {!editingModel ? (
                <div className="cu-agent-detail-heading__actions">
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost cu-btn--sm"
                    onClick={() => setEditingModel(true)}
                    disabled={busy}
                  >
                    Edit
                  </button>
                </div>
              ) : null}
            </div>

            {!editingModel ? (
              <div className="cu-form-stack">
                <div className="cu-field">
                  <label htmlFor="model-secret">LLM Secret</label>
                  <div className="cu-field__readonly">{secretRefDraft || '-'}</div>
                </div>
                <div className="cu-field">
                  <label htmlFor="model-provider">Model provider</label>
                  <div className="cu-field__readonly">{getProviderLabel(providerDraft)}</div>
                </div>
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
                {pendingCredentialRemovals.length > 0 ? (
                  <div className="cu-banner cu-banner--warning" style={{ marginBottom: '0.75rem' }}>
                    <span>
                      Removed provider credential(s): {pendingCredentialRemovals.join(', ')}. They
                      will be deleted from the LLM Secret when you save.
                    </span>
                    <button
                      type="button"
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      onClick={() => {
                        setRetireCandidates([])
                        setAdditionalRetireCandidates([])
                      }}
                      disabled={busy}
                    >
                      Keep them
                    </button>
                  </div>
                ) : null}
                <section className="cu-agent-credential-set" aria-label="LLM Secret">
                  <div className="cu-agent-credential-set__head">
                    <div>
                      <span className="cu-agent-credential-set__eyebrow">LLM Secret</span>
                      <h4 className="cu-agent-credential-set__title">
                        {secretRefDraft || 'No LLM Secret linked'}
                      </h4>
                      <p className="cu-field__hint">
                        One LLM Secret can contain credentials for several providers. Changes here
                        apply to the Secret and may affect other agents that use it.
                      </p>
                    </div>
                    <Link
                      className="cu-btn cu-btn--ghost cu-btn--sm"
                      href={CONTROL_ROUTES.secrets.llm}
                    >
                      Manage LLM Secrets
                    </Link>
                  </div>
                  <div className="cu-field">
                    <label htmlFor="host-credential-set">Linked LLM Secret</label>
                    <SelectionDropdown
                      id="host-credential-set"
                      value={secretRefDraft ? [secretRefDraft] : []}
                      options={credentialSetOptions}
                      placeholder="Select an LLM Secret…"
                      searchPlaceholder="Search LLM Secrets…"
                      selectionLabel="LLM Secret"
                      multiple={false}
                      showSelectedChips={false}
                      disabled={busy}
                      onChange={next => {
                        const nextSecret = next[0] ?? ''
                        if (nextSecret === secretRefDraft) return
                        setSecretRefDraft(nextSecret)
                        // A write-only draft belongs to the selected set. Never
                        // carry a replacement or retirement from set A into set B.
                        setLlmKeyDraft({})
                        setRetireCandidates([])
                        setAdditionalRetireCandidates([])
                      }}
                    />
                  </div>
                  <div className="cu-agent-credential-set__providers">
                    <span className="cu-agent-credential-set__providers-label">
                      Providers in this set
                    </span>
                    {credentialSetProviders.length > 0 ? (
                      <div className="cu-chip-row">
                        {credentialSetProviders.map(({ provider, usable }) => (
                          <span className="cu-chip" key={provider}>
                            {getProviderLabel(provider)} · {usable ? 'configured' : 'incomplete'}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="cu-field__hint">
                        No provider keys are visible yet. Credential values are never exposed here.
                      </span>
                    )}
                  </div>
                </section>
                <LlmProviderConfig
                  provider={providerDraft}
                  model={modelNameDraft}
                  onPrimaryChange={next => {
                    setProviderDraft(next.provider)
                    setModelNameDraft(next.model)
                  }}
                  policy={llmPolicyDraft}
                  onPolicyChange={handlePolicyChange}
                  allowedModels={allowedModelsDraft}
                  onAllowedModelsChange={setAllowedModelsDraft}
                  catalog={allowedCatalog}
                  catalogLoading={modelsLoading}
                  catalogError={modelsError}
                  replacePrimaryModelWithAllowedModels
                  credentials={{
                    draft: llmKeyDraft,
                    onChange: (dataKey, value) =>
                      setLlmKeyDraft(prev => ({ ...prev, [dataKey]: value })),
                    existingKeys: currentSecretKeys,
                  }}
                  secretKeys={currentSecretKeys}
                  disabled={busy}
                />
                <section className="cu-llm-config__block cu-agent-additional-credentials">
                  <div className="cu-llm-config__block-head">
                    <span className="cu-llm-config__block-title">Additional providers</span>
                    <span className="cu-llm-config__block-tag cu-llm-config__block-tag--muted">
                      Optional
                    </span>
                  </div>
                  <p className="cu-field__hint cu-agent-additional-credentials__intro">
                    Add credentials for another provider to this set. They become available to the
                    agent when you select that provider as primary or as a fallback.
                  </p>
                  <LlmCredentialFields
                    draft={additionalCredentialDraft}
                    onChange={(dataKey, value) =>
                      setLlmKeyDraft(prev => ({ ...prev, [dataKey]: value }))
                    }
                    existingKeys={additionalCredentialKeys}
                    excludedProviders={Array.from(activeCredentialProviders)}
                    onRemovedKeysChange={next =>
                      setAdditionalRetireCandidates(prev =>
                        prev.join('\n') === next.join('\n') ? prev : next
                      )
                    }
                    disabled={busy}
                  />
                </section>
                <div className="cu-create-actions cu-agent-model-actions">
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
                    disabled={busy}
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
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

        {activeTab === 'connectors' && (
          <>
            <div className="cu-agent-detail-heading">
              <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
                Connectors available to this agent.
              </p>
              <div className="cu-agent-detail-heading__actions">
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() => void openAddConnectorDialog()}
                  disabled={busy || !agentContext}
                >
                  Add connector
                </button>
              </div>
            </div>
            <div className="cu-table-wrap">
              <table className="cu-table cu-table--header-band cu-table--static-rows cu-agent-connectors-table">
                <thead>
                  <tr>
                    <th>Connector</th>
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
                  ) : contextMcpServers.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="cu-empty">
                        No connectors attached yet.
                      </td>
                    </tr>
                  ) : (
                    contextMcpServers.map(server => (
                      <tr key={server}>
                        <td>
                          <span className="cu-table__cell-name">{server}</span>
                        </td>
                        <td className="cu-table__cell-actions">
                          <div className="cu-table-actions">
                            <RowActionsMenu
                              ariaLabel={`Actions for connector ${server}`}
                              horizontalTrigger
                              actions={[
                                {
                                  key: 'remove',
                                  label: 'Remove connector',
                                  danger: true,
                                  disabled: busy,
                                  onClick: () => void removeAgentConnector(server),
                                },
                              ]}
                            />
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {showAddConnector && (
          <div
            className="cu-modal-backdrop"
            role="presentation"
            onMouseDown={event => {
              if (event.target === event.currentTarget && !busy) {
                setShowAddConnector(false)
                setSelectedConnectorNames([])
              }
            }}
          >
            <section
              className="cu-modal-panel cu-modal-panel--selection"
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-agent-connector-title"
              onMouseDown={event => event.stopPropagation()}
            >
              <div className="cu-modal-panel__head">
                <h3 id="add-agent-connector-title" className="cu-modal-panel__title">
                  Add connectors
                </h3>
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--ghost"
                  onClick={() => {
                    setShowAddConnector(false)
                    setSelectedConnectorNames([])
                  }}
                  disabled={busy}
                  aria-label="Close"
                >
                  <IconX width={18} height={18} />
                </button>
              </div>

              <p className="cu-modal-copy">
                Select the connectors this agent can use. You can change this later.
              </p>

              {connectorCatalogLoading ? (
                <div className="cu-empty">Loading available connectors…</div>
              ) : (
                <div className="cu-field">
                  <label htmlFor="agent-connector-picker">Connectors</label>
                  <SelectionDropdown
                    id="agent-connector-picker"
                    inline
                    value={selectedConnectorNames}
                    onChange={setSelectedConnectorNames}
                    options={connectorOptions}
                    placeholder="Select connectors"
                    searchPlaceholder="Search connectors..."
                    selectionLabel="Selected connectors"
                    emptyLabel="No additional connectors available."
                    disabled={busy}
                  />
                </div>
              )}

              <div className="cu-modal-panel__foot">
                <button
                  type="button"
                  className="cu-btn cu-btn--ghost cu-btn--sm"
                  onClick={() => {
                    setShowAddConnector(false)
                    setSelectedConnectorNames([])
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="cu-btn cu-btn--primary"
                  onClick={async () => {
                    const saved = await saveAgentConnectors([
                      ...contextMcpServers,
                      ...selectedConnectorNames,
                    ])
                    if (saved) {
                      setShowAddConnector(false)
                      setSelectedConnectorNames([])
                    }
                  }}
                  disabled={
                    busy ||
                    connectorCatalogLoading ||
                    selectedConnectorNames.length === 0 ||
                    !agentContext
                  }
                >
                  {selectedConnectorNames.length > 1 ? 'Add connectors' : 'Add connector'}
                </button>
              </div>
            </section>
          </div>
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
