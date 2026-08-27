'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CreateFlowPanel } from '@/components/CreateFlowPanel'
import { CreateStepFlow } from '@/components/CreateStepFlow'
import { LlmProviderConfig } from '@/components/LlmProviderConfig'
import { LlmSecretSelect } from '@/components/LlmSecretSelect'
import { SelectionDropdown } from '@/components/SelectionDropdown'
import { useToast } from '@/components/Toast'
import { IconAlertTriangle, IconCheck, IconX } from '@/components/icons'
import { Button, CheckboxField, Field, TextInput } from '@/components/ui'
import { createAgentContextName } from '@/lib/agentContext'
import {
  apiSend,
  getAdminTeams,
  getAdminUsers,
  updateAgentTeams,
  updateAgentUsers,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { useLlmAllowedModels } from '@/lib/hooks/useLlmAllowedModels'
import { getAgentNameError } from '@/lib/k8sValidation'
import {
  type HostAllowedModel,
  type LlmPolicy,
  type LlmProvider,
  buildAllowedModelsSpec,
  createEmptyLlmKeyDraft,
  getActiveCredentialKeys,
  getModelOptions,
  getProviderLabel,
  getProvidersWithCompleteCredentials,
  isProviderUsable,
  projectCredentialDraft,
  resolveDefaultModel,
  validateLlmSecretData,
} from '@/lib/llm'
import { toKebabCase, toKebabInput } from '@/lib/string'
import {
  HOST_NAMESPACE,
  HOST_SECRET_LABEL_KEY,
  HOST_SECRET_LABEL_VALUE,
  STEPS,
  STEP_DETAILS,
} from './constants'
import type { CreatedResource, HostWizardProps, HostWizardValidationState } from './types'

// Stateless lifecycle support remains intact in the API and existing-agent UI;
// only creation through this wizard is temporarily unavailable.
const SHOW_STATELESS_AGENT_SELECTOR = false

// Asymmetric save gate (spec Topic 1b): the PRIMARY provider must be usable —
// its required credential slot(s) filled — before create is allowed. Fallbacks
// are optional and only warn, so they never enter this gate.
function primaryCredentialUsable(provider: LlmProvider, draft: Record<string, string>): boolean {
  return isProviderUsable(provider, key => (draft[key] ?? '').trim().length > 0)
}

// The DELETE path for one tracked sibling. The server fixes each resource's
// namespace (secrets → config.secretsNamespace; hosts/contexts/channels →
// their configured namespace), so — exactly like the SecretsTable /
// CommunicationChannelsTable / deleteContext call-sites — no namespace query is
// sent. Deleting a communicationchannel also removes its credentials Secret
// server-side, so a channel's credential Secret is never tracked or deleted
// separately here.
function compensationPath(entry: CreatedResource): string {
  const encoded = encodeURIComponent(entry.name)
  switch (entry.kind) {
    case 'secret':
      return `/api/v1/admin/secrets/${encoded}`
    case 'context':
      return `/api/v1/admin/contexts/${encoded}`
    case 'communication-channel':
      return `/api/v1/admin/communication-channels/${encoded}`
  }
}

// Inverse-order (channel → context → secret) best-effort rollback of the
// siblings THIS run created before the Host create failed, so a failed create
// never leaves an orphaned secret/context/channel behind. Best-effort: each
// DELETE is independent, a 404 is success (idempotent — the resource is already
// gone), and NO failure is re-thrown — a rollback error must never mask the
// original create error the caller is about to surface. The server performs a
// direct delete with no referential-integrity/finalizer coupling between the
// siblings, so inverse order is for tidiness, not correctness.
async function compensateCreated(created: CreatedResource[]): Promise<void> {
  for (let i = created.length - 1; i >= 0; i -= 1) {
    const entry = created[i]
    try {
      await apiSend('DELETE', compensationPath(entry))
    } catch (err) {
      console.warn(
        `HostWizard: best-effort rollback of ${entry.kind} "${entry.name}" failed after a create error`,
        err
      )
    }
  }
}

// A create-only POST, with the 409 disambiguation done HERE — at the create
// site — never in the shared submitAll catch. This is deliberate: only a POST to
// a create-only /admin/{secrets,contexts,communication-channels,hosts} endpoint
// can turn a code-less 409 into an UNAMBIGUOUS AlreadyExists name collision. The
// grant endpoints (409 `deleted_agent_history_limit_exceeded`) share the
// top-level catch but can NEVER reach here, so their messages are preserved.
//
// The two 409 shapes from THESE endpoints (V-1):
//   - WITH a body `code` (context_crd_outdated / communication_channel_crd_outdated)
//     → a CRD-outdated response, NOT a collision. formatApiError already set
//       e.message to the server's human `error` text, so re-throw e untouched.
//   - WITHOUT a body `code` → apiserver AlreadyExists. The create-only POST
//     refused to overwrite a foreign resource; replace the raw K8s text with the
//     friendly, per-resource `collisionMessage`.
// Discriminate on `body.code` (the field INSIDE the JSON body), never on the
// client's `.code` (which formatApiError sets from `body.error`, the message).
// Any non-409 error is re-thrown verbatim.
class ResourceNameCollisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResourceNameCollisionError'
  }
}

async function createOrThrow(path: string, body: unknown, collisionMessage: string): Promise<void> {
  try {
    await apiSend('POST', path, body)
  } catch (e) {
    if (e instanceof Error && (e as Error & { status?: number }).status === 409) {
      const errBody = (e as Error & { body?: { code?: unknown } }).body
      const hasCode = typeof errBody?.code === 'string' && errBody.code.length > 0
      // Code-less 409 from a create-only POST = unambiguous name collision.
      if (!hasCode) throw new ResourceNameCollisionError(collisionMessage)
      // Coded 409 (CRD-outdated) keeps the server's own message (e.message).
    }
    throw e
  }
}

async function createPrivateContext(
  agentName: string,
  selectedMcpServers: string[],
  collisionMessage: string
): Promise<string> {
  // A generated context name is an implementation detail. Hide the rare
  // collision from the operator by trying one fresh suffix before surfacing the
  // existing friendly error. The successful name is returned to become the
  // Host's contextRef.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const contextName = createAgentContextName(agentName)
    try {
      await createOrThrow(
        '/api/v1/admin/contexts',
        {
          metadata: { name: contextName },
          spec: {
            contextId: contextName,
            description: `Connector context for agent ${agentName}`,
            mcpServers: selectedMcpServers,
          },
        },
        collisionMessage
      )
      return contextName
    } catch (error) {
      if (!(error instanceof ResourceNameCollisionError) || attempt === 1) throw error
    }
  }

  throw new Error(collisionMessage)
}

function isStepValid(stepIndex: number, state: HostWizardValidationState): boolean {
  if (stepIndex === 0)
    return state.hostName.trim().length > 0 && getAgentNameError(state.hostName) === ''
  if (stepIndex === 1) {
    // New secret: the PRIMARY provider must be usable (asymmetric gate — a
    // fallback missing its key only warns). Cross-slot mistakes (half Bedrock
    // pair, malformed Vertex JSON) anywhere still block. Existing secret: the
    // wizard can't introspect its keys, so a selection is the only gate.
    // Validate only the ACTIVE-domain keys — a value typed for a provider whose
    // block later unmounted (primary switched, or a fallback removed) must not
    // block (e.g. a lone Bedrock access key left behind by a removed fallback).
    const projectedDraft = projectCredentialDraft(
      state.llmKeyDraft,
      getActiveCredentialKeys(state.provider, state.llmPolicy)
    )
    const hasValidSecret =
      state.secretMode === 'existing'
        ? state.existingSecret.trim().length > 0
        : toKebabCase(state.newSecretName).length > 0 &&
          primaryCredentialUsable(state.provider, state.llmKeyDraft) &&
          validateLlmSecretData(projectedDraft).length === 0
    return hasValidSecret && state.modelName.trim().length > 0
  }
  if (stepIndex === 2 || stepIndex === 3) return true
  return false
}

export function HostWizard({
  mcpServers,
  existingSecrets,
  mode = 'modal',
  onCreated,
  onClose,
  pageHeader,
}: HostWizardProps) {
  const { showToast } = useToast()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryLoadError, setDirectoryLoadError] = useState('')
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const [hostName, setHostName] = useState('')
  const hostNamespace = HOST_NAMESPACE
  const agentNameError = getAgentNameError(hostName)

  const [selectedMcp, setSelectedMcp] = useState<string[]>([])

  // Reuse an existing shared Secret by default. Creating an agent-specific Secret
  // remains available when the operator explicitly chooses New credential.
  const [secretMode, setSecretMode] = useState<'existing' | 'new'>('existing')
  const [existingSecret, setExistingSecret] = useState('')
  const [newSecretName, setNewSecretName] = useState('')
  const [secretNameTouched, setSecretNameTouched] = useState(false)
  const [llmKeyDraft, setLlmKeyDraft] = useState<Record<string, string>>(createEmptyLlmKeyDraft)
  const [llmPolicy, setLlmPolicy] = useState<LlmPolicy | undefined>(undefined)
  // Per-host model allowlist subset (spec.allowedModels, Topic 3a). Empty = the
  // host offers the full global allowlist per provider (back-compat default).
  const [allowedModels, setAllowedModels] = useState<HostAllowedModel[]>([])

  const [provider, setProvider] = useState<LlmProvider>('openai')
  // Model list is the operator allowlist (enabled only), loaded async. Start
  // empty; an effect selects the default once the allowlist arrives. No
  // hardcoded fallback list (spec R4.5.1).
  const {
    models: allowedCatalog,
    loading: modelsLoading,
    error: modelsError,
  } = useLlmAllowedModels()
  const [modelName, setModelName] = useState('')
  const [stateless, setStateless] = useState(false)
  const [users, setUsers] = useState<
    Array<{ id: string; email: string; name: string | null; displayName: string | null }>
  >([])
  const [teams, setTeams] = useState<Array<{ id: string; name: string; memberCount: number }>>([])
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([])
  const [accessTab, setAccessTab] = useState<'members' | 'teams'>('members')

  const availableMcp = useMemo(
    () =>
      mcpServers
        .map(m => m.metadata?.name)
        .filter((v): v is string => Boolean(v))
        .sort(),
    [mcpServers]
  )

  const secretOptions = useMemo(
    () =>
      existingSecrets
        .map(secret => {
          const name = secret.name || secret.metadata?.name
          if (!name) return null
          const providers = Array.isArray(secret.keys)
            ? getProvidersWithCompleteCredentials(secret.keys)
            : null
          const providerSummary =
            providers === null
              ? 'Provider keys unavailable'
              : providers.length > 0
                ? `Providers: ${providers.map(getProviderLabel).join(', ')}`
                : 'No recognized provider credentials'
          return {
            value: name,
            label: name,
            meta: providerSummary,
            providers:
              providers && providers.length > 0
                ? providers.map(id => ({ id, label: getProviderLabel(id) }))
                : undefined,
          }
        })
        .filter(option => option !== null)
        .sort((left, right) => left.value.localeCompare(right.value)),
    [existingSecrets]
  )
  const providerModelOptions = useMemo(
    () => getModelOptions(allowedCatalog, provider),
    [allowedCatalog, provider]
  )
  const handleExistingSecretChange = useCallback(
    (secretName: string) => {
      setExistingSecret(secretName)
      const selectedSecret = existingSecrets.find(
        secret => (secret.name || secret.metadata?.name) === secretName
      )
      if (!Array.isArray(selectedSecret?.keys)) return
      const [linkedProvider] = getProvidersWithCompleteCredentials(selectedSecret.keys)
      if (!linkedProvider) return
      setProvider(linkedProvider)
      setModelName(
        resolveDefaultModel(linkedProvider, getModelOptions(allowedCatalog, linkedProvider))
      )
    },
    [allowedCatalog, existingSecrets]
  )
  // Keep the selected model valid for the current provider's enabled models:
  // seed the default once the allowlist loads, and re-default if a provider
  // switch left the model out of range.
  useEffect(() => {
    if (modelsLoading) return
    if (!providerModelOptions.includes(modelName)) {
      setModelName(resolveDefaultModel(provider, providerModelOptions))
    }
    // Intentionally omit modelName: this reconciles the picker to the options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerModelOptions, modelsLoading])

  // Auto-derive the new Secret name from the agent name ("this agent's
  // credentials") until the operator edits it, so naming a Kubernetes Secret is
  // never a required step (spec Topic 1b R4). The field stays visible + editable.
  useEffect(() => {
    if (secretNameTouched) return
    const base = toKebabCase(hostName)
    setNewSecretName(base ? `${base}-llm` : '')
  }, [hostName, secretNameTouched])

  // Keys feeding the fallback credentialSlot dropdown in create: the extra slots
  // the operator typed a value for, plus any slot a fallback already points at.
  const llmSecretKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const [key, value] of Object.entries(llmKeyDraft)) {
      if (value.trim().length > 0) keys.add(key)
    }
    for (const fallback of llmPolicy?.fallbacks ?? []) {
      if (fallback.credentialSlot) keys.add(fallback.credentialSlot)
    }
    return Array.from(keys)
  }, [llmKeyDraft, llmPolicy])
  const memberAccessOptions = useMemo(
    () =>
      users.map(user => ({
        value: user.id,
        label: user.displayName || user.name || user.email,
        description: user.email || 'Member',
      })),
    [users]
  )
  const teamAccessOptions = useMemo(
    () =>
      teams.map(team => ({
        value: team.id,
        label: team.name,
        description: `${team.memberCount} ${team.memberCount === 1 ? 'member' : 'members'}`,
      })),
    [teams]
  )

  const canNext = useMemo(() => {
    return isStepValid(step, {
      hostName,
      secretMode,
      existingSecret,
      newSecretName,
      llmKeyDraft,
      llmPolicy,
      provider,
      modelName,
    })
  }, [
    step,
    hostName,
    secretMode,
    existingSecret,
    newSecretName,
    llmKeyDraft,
    llmPolicy,
    provider,
    modelName,
  ])

  const loadDirectory = useCallback(async () => {
    setDirectoryLoading(true)
    setDirectoryLoadError('')
    setError('')
    try {
      const [usersData, teamsData] = await Promise.all([getAdminUsers(''), getAdminTeams()])
      if (!mountedRef.current) return
      setUsers(Array.isArray(usersData.items) ? usersData.items : [])
      setTeams(Array.isArray(teamsData.items) ? teamsData.items : [])
    } catch (e) {
      if (!mountedRef.current) return
      const message =
        e instanceof Error
          ? `Failed to load users/teams: ${e.message}. You may not be able to grant access from this wizard — retry or check your session.`
          : 'Failed to load users/teams. You may not be able to grant access from this wizard.'
      setDirectoryLoadError(message)
      setError(message)
    } finally {
      if (mountedRef.current) setDirectoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDirectory()
  }, [loadDirectory])

  const canJumpToStep = useMemo(
    () => (targetStep: number) => {
      if (targetStep <= step) return true
      for (let i = 0; i < targetStep; i += 1) {
        if (
          !isStepValid(i, {
            hostName,
            secretMode,
            existingSecret,
            newSecretName,
            llmKeyDraft,
            llmPolicy,
            provider,
            modelName,
          })
        ) {
          return false
        }
      }
      return true
    },
    [
      step,
      hostName,
      secretMode,
      existingSecret,
      newSecretName,
      llmKeyDraft,
      llmPolicy,
      provider,
      modelName,
    ]
  )

  const validationMessage = useMemo(() => {
    if (step === 0) {
      const agentNameError = getAgentNameError(hostName)
      if (agentNameError) return agentNameError
    }
    if (step === 1 && !modelName.trim()) return 'Model name is required.'
    if (step === 1 && secretMode === 'existing' && !existingSecret.trim())
      return 'Select an existing LLM Secret.'
    if (step === 1 && secretMode === 'new' && !toKebabCase(newSecretName)) {
      return 'For a new LLM Secret, set a name.'
    }
    if (step === 1 && secretMode === 'new' && !primaryCredentialUsable(provider, llmKeyDraft)) {
      return `Add the ${getProviderLabel(provider)} credential for the primary model.`
    }
    if (step === 1 && secretMode === 'new') {
      const projected = projectCredentialDraft(
        llmKeyDraft,
        getActiveCredentialKeys(provider, llmPolicy)
      )
      const slotErrors = validateLlmSecretData(projected)
      if (slotErrors.length > 0) return slotErrors[0]
    }
    return ''
  }, [
    step,
    hostName,
    secretMode,
    existingSecret,
    newSecretName,
    llmKeyDraft,
    llmPolicy,
    provider,
    modelName,
  ])

  function resetForm() {
    setStep(0)
    setError('')

    setHostName('')
    setSelectedMcp([])
    setSecretMode('existing')
    setExistingSecret('')
    setNewSecretName('')
    setSecretNameTouched(false)
    setLlmKeyDraft(createEmptyLlmKeyDraft())
    setLlmPolicy(undefined)
    setAllowedModels([])
    setProvider('openai')
    setModelName(resolveDefaultModel('openai', getModelOptions(allowedCatalog, 'openai')))
    setStateless(false)
    setSelectedUserIds([])
    setSelectedTeamIds([])
    setAccessTab('members')
  }

  useEffect(() => {
    resetForm()
  }, [])

  function toggleMcp(name: string) {
    setSelectedMcp(prev => {
      const set = new Set(prev)
      if (set.has(name)) set.delete(name)
      else set.add(name)
      return Array.from(set)
    })
  }

  async function submitAll() {
    setBusy(true)
    setError('')
    // Rollback ledger for the create-only seam: every sibling THIS run POSTs
    // successfully is appended here so a later failure (before the Host exists)
    // can inverse-compensate it. Only successful POSTs of this execution are
    // tracked — never inferred from slug/label. Declared outside the try so the
    // catch can read it.
    const created: CreatedResource[] = []
    let hostCreated = false
    try {
      const normalizedHostName = toKebabCase(hostName)
      const normalizedSecretName = toKebabCase(newSecretName)

      if (secretMode === 'new') {
        // Project the draft onto the active domain before writing: only the
        // primary provider's slots ∪ each fallback's effective slot(s) reach the
        // Secret — a key left behind by a since-removed provider is dropped, not
        // written as an orphan (spec Topic 1b).
        const stringData = projectCredentialDraft(
          llmKeyDraft,
          getActiveCredentialKeys(provider, llmPolicy)
        )
        // Slot-aware validation (spec R4.5.3), mirrored server-side.
        const slotErrors = validateLlmSecretData(stringData)
        if (slotErrors.length > 0) {
          throw new Error(slotErrors[0])
        }
        // Create-only POST (R5-C1/R5-B1): a name collision must 409 AlreadyExists
        // server-side, never silently overwrite a foreign Secret via a PUT. The
        // 409 → friendly message translation is scoped to createOrThrow.
        await createOrThrow(
          '/api/v1/admin/secrets',
          {
            name: normalizedSecretName,
            namespace: hostNamespace,
            labels: {
              [HOST_SECRET_LABEL_KEY]: HOST_SECRET_LABEL_VALUE,
            },
            stringData,
          },
          `A credential secret named "${normalizedSecretName}" already exists — choose another name.`
        )
        // The host's own LLM Secret (${slug}-llm). Tracked so a later failure
        // rolls it back explicitly by name.
        created.push({ kind: 'secret', name: normalizedSecretName })
      }

      // Every agent gets a private implementation context. The context name is
      // intentionally generated here instead of being exposed as a wizard
      // field; the agent still needs a contextRef for its runtime contract.
      const generatedContextName = await createPrivateContext(
        normalizedHostName,
        Array.from(new Set(selectedMcp)),
        'We couldn’t finish setting up this agent’s connectors — please try again.'
      )
      created.push({ kind: 'context', name: generatedContextName })

      // Effective per-host model subset (Topic 3a): prune the draft to the
      // providers actually in this host's domain (primary + fallbacks), then
      // collapse unrestricted/all-selected providers via buildAllowedModelsSpec.
      const activeAllowedProviders = new Set<string>([
        provider,
        ...(llmPolicy?.fallbacks ?? []).map(fallback => fallback.provider),
      ])
      const allowedModelsSpec = buildAllowedModelsSpec(
        allowedModels.filter(entry => activeAllowedProviders.has(entry.provider)),
        allowedCatalog
      )

      const hostSpec: Record<string, unknown> = {
        host: normalizedHostName,
        contextRef: generatedContextName,
        secretRef: secretMode === 'existing' ? existingSecret : normalizedSecretName,
        channels: [],
        model: {
          provider,
          name: modelName,
        },
        // Opt-in fallback policy (spec §3-R5): only set when at least one
        // fallback is configured, so a Host without fallbacks behaves as today.
        ...(llmPolicy && llmPolicy.fallbacks.length > 0 ? { llmPolicy } : {}),
        // Per-host model allowlist subset (spec Topic 3a): only set when the
        // operator restricted at least one provider to a genuine subset;
        // unrestricted providers are omitted so absent=all-global holds.
        ...(allowedModelsSpec.length > 0 ? { allowedModels: allowedModelsSpec } : {}),
        ...(stateless ? { lifecycle: { stateless: true } } : {}),
      }

      // Create-only POST (R5-C1/R5-B1): the Host is the seam boundary. A name
      // collision must 409 AlreadyExists rather than overwrite a foreign agent's
      // entire spec. Once this resolves, hostCreated flips the compensation off:
      // the siblings now belong to a real Host and must NOT be rolled back.
      await createOrThrow(
        '/api/v1/admin/hosts',
        {
          metadata: { name: normalizedHostName },
          spec: hostSpec,
        },
        `That agent name is already in use — choose another name.`
      )
      hostCreated = true

      // Associate authorized users and teams with the new agent in a single
      // atomic call each, rather than looping N×(GET+PUT) per selection.
      // Uses the agent-centric endpoints PUT /admin/agents/:name/users|teams.
      // These run AFTER hostCreated=true: if a grant fails, the Host + siblings
      // stay (V-7) — the operator retries grants from the agent detail page — so
      // no compensation runs for a grant failure.
      if (selectedUserIds.length > 0) {
        await updateAgentUsers(normalizedHostName, selectedUserIds)
      }
      if (selectedTeamIds.length > 0) {
        await updateAgentTeams(normalizedHostName, selectedTeamIds)
      }

      if (!mountedRef.current) return
      showToast('Agent created successfully.', { tone: 'success' })
      await onCreated()
      if (!mountedRef.current) return
      onClose()
    } catch (e) {
      // The Host is the compensation boundary (V-7): if it never got created, the
      // siblings created before it are orphans — inverse-compensate them
      // best-effort. If it DID get created, leave everything (a grant failure is
      // recoverable from the agent detail page). Always await the rollback before
      // surfacing the error so a caller/test observes the terminal state.
      if (!hostCreated) {
        await compensateCreated(created)
      }
      // NO 409 remap here: each create-only POST already translated its OWN
      // collision inside createOrThrow. This catch also sees errors from paths
      // that run AFTER the Host — the grant calls (409
      // `deleted_agent_history_limit_exceeded`) — whose messages formatApiError
      // already produced; masking them as "already in use" told the operator a
      // collision that never happened. Preserve e.message verbatim.
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to create agent resources')
      }
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const wizardBody = (
    <>
      {mode === 'modal' ? (
        <div className="cu-agent-dialog-head">
          <strong id="create-agent-title" className="cu-modal-panel__title">
            Create Agent
          </strong>
          <Button
            type="button"
            className="cu-btn--icon"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            variant="ghost"
          >
            <IconX width={18} height={18} />
          </Button>
        </div>
      ) : null}

      <CreateStepFlow
        ariaLabel="Create agent steps"
        currentStep={step}
        onStepChange={setStep}
        canSelectStep={canJumpToStep}
        steps={STEP_DETAILS}
        stepLabels={STEPS}
        titleId={mode === 'page' ? 'create-agent-title' : 'create-agent-step-title'}
      >
        {step === 0 && (
          <div className="cu-form-stack cu-agent-form-stack">
            <Field
              description="Automatically formatted to lowercase with hyphens."
              label="Agent metadata name"
              required
            >
              <span className="cu-agent-input-shell">
                <TextInput
                  value={hostName}
                  onChange={e => setHostName(toKebabInput(e.target.value))}
                  placeholder="agent-name"
                  autoFocus
                />
                {hostName.trim() ? (
                  agentNameError ? (
                    <span
                      className="cu-agent-input-shell__status cu-agent-input-shell__status--invalid"
                      aria-label={agentNameError}
                    >
                      <IconAlertTriangle width={16} height={16} />
                    </span>
                  ) : (
                    <span className="cu-agent-input-shell__status" aria-label="Valid agent name">
                      <IconCheck width={16} height={16} />
                    </span>
                  )
                ) : null}
              </span>
            </Field>
            <div className="cu-agent-namespace">Namespace: {HOST_NAMESPACE}</div>
            {SHOW_STATELESS_AGENT_SELECTOR ? (
              <div className="cu-agent-access-section">
                <strong id="agent-type-label">Agent type</strong>
                <span className="cu-muted cu-agent-access-hint">
                  Stateless agents suspend after the idle window and wake on demand. Communication
                  channels keep stateless agents always-on unless the cluster explicitly enables
                  wake-on-interaction; desktop still requires a stateful agent.
                </span>
                <div
                  className="cu-agent-radio-group"
                  role="radiogroup"
                  aria-labelledby="agent-type-label"
                >
                  <label className="cu-agent-radio cu-agent-radio--card">
                    <input
                      type="radio"
                      name="agent-type"
                      checked={!stateless}
                      onChange={() => setStateless(false)}
                    />
                    <span className="cu-agent-radio__copy">
                      <span className="cu-agent-radio__title">Stateful (always on)</span>
                      <span className="cu-agent-radio__description">
                        The agent keeps running continuously and responds immediately.
                      </span>
                    </span>
                  </label>
                  <label className="cu-agent-radio cu-agent-radio--card">
                    <input
                      type="radio"
                      name="agent-type"
                      checked={stateless}
                      onChange={() => setStateless(true)}
                    />
                    <span className="cu-agent-radio__copy">
                      <span className="cu-agent-radio__title">Stateless (suspends when idle)</span>
                      <span className="cu-agent-radio__description">
                        The platform suspends the agent when idle and wakes it on demand.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {step === 1 && (
          <div className="cu-form-stack cu-agent-form-stack">
            <div className="cu-agent-access-section">
              <strong>LLM credentials</strong>
              <span className="cu-muted cu-agent-access-hint">
                Link an existing LLM Secret or create one for this agent.
              </span>
              <div className="cu-agent-radio-group">
                <label className="cu-agent-radio cu-agent-radio--card">
                  <input
                    type="radio"
                    checked={secretMode === 'existing'}
                    onChange={() => setSecretMode('existing')}
                  />
                  <span className="cu-agent-radio__copy">
                    <span className="cu-agent-radio__title">Use an existing LLM Secret</span>
                    <span className="cu-agent-radio__description">
                      Link a saved LLM Secret that already contains provider credentials.
                    </span>
                  </span>
                </label>
                <label className="cu-agent-radio cu-agent-radio--card">
                  <input
                    type="radio"
                    checked={secretMode === 'new'}
                    onChange={() => setSecretMode('new')}
                  />
                  <span className="cu-agent-radio__copy">
                    <span className="cu-agent-radio__title">Create a new LLM Secret</span>
                    <span className="cu-agent-radio__description">
                      Create a private LLM Secret for this agent. Its internal name is derived from
                      the agent name.
                    </span>
                  </span>
                </label>
              </div>
              {secretMode === 'existing' ? (
                <div className="cu-agent-access-section">
                  <strong>LLM Secret</strong>
                  <LlmSecretSelect
                    value={existingSecret}
                    placeholder="Select LLM Secret..."
                    options={secretOptions}
                    onChange={handleExistingSecretChange}
                  />
                </div>
              ) : (
                <Field
                  description="Auto-named from the agent — edit the internal name if you prefer a different one."
                  label="LLM Secret name"
                >
                  <span className="cu-agent-input-shell">
                    <TextInput
                      value={newSecretName}
                      onChange={e => {
                        setSecretNameTouched(true)
                        setNewSecretName(toKebabInput(e.target.value))
                      }}
                      placeholder="llm-secret-name"
                    />
                    <span
                      className={cn(
                        'cu-agent-input-shell__status',
                        !toKebabCase(newSecretName) && 'cu-agent-input-shell__status--empty'
                      )}
                      aria-label={
                        toKebabCase(newSecretName)
                          ? 'Valid LLM Secret name'
                          : 'LLM Secret name empty'
                      }
                    >
                      {toKebabCase(newSecretName) ? <IconCheck width={16} height={16} /> : null}
                    </span>
                  </span>
                </Field>
              )}
            </div>
            <LlmProviderConfig
              provider={provider}
              model={modelName}
              onPrimaryChange={next => {
                setProvider(next.provider)
                setModelName(next.model)
              }}
              policy={llmPolicy}
              onPolicyChange={setLlmPolicy}
              allowedModels={allowedModels}
              onAllowedModelsChange={setAllowedModels}
              catalog={allowedCatalog}
              catalogLoading={modelsLoading}
              catalogError={modelsError}
              modelLabel="Default model"
              showAllowedModels={false}
              credentials={
                secretMode === 'new'
                  ? {
                      draft: llmKeyDraft,
                      onChange: (dataKey, value) =>
                        setLlmKeyDraft(prev => ({ ...prev, [dataKey]: value })),
                    }
                  : undefined
              }
              secretKeys={secretMode === 'new' ? llmSecretKeys : []}
              fallbackProvidersInitiallyCollapsed
              disabled={busy}
            />
          </div>
        )}

        {step === 2 && (
          <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
            {directoryLoadError ? (
              <div className="cu-workflow-access__error" role="alert">
                <span>{directoryLoadError}</span>
                <Button
                  type="button"
                  className="cu-btn--sm"
                  variant="ghost"
                  onClick={() => void loadDirectory()}
                  disabled={busy || directoryLoading}
                >
                  {directoryLoading ? 'Retrying...' : 'Retry'}
                </Button>
              </div>
            ) : null}
            <div className="cu-agent-access-section">
              <div className="cu-agent-access-tabs" role="tablist" aria-label="Access type">
                <button
                  type="button"
                  className="cu-agent-access-tab"
                  role="tab"
                  aria-selected={accessTab === 'members'}
                  data-active={accessTab === 'members'}
                  onClick={() => setAccessTab('members')}
                >
                  {selectedUserIds.length > 0 ? <IconCheck width={14} height={14} /> : null}
                  <span>Members</span>
                  {selectedUserIds.length > 0 ? (
                    <span className="cu-agent-access-tab__count">{selectedUserIds.length}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="cu-agent-access-tab"
                  role="tab"
                  aria-selected={accessTab === 'teams'}
                  data-active={accessTab === 'teams'}
                  onClick={() => setAccessTab('teams')}
                >
                  {selectedTeamIds.length > 0 ? <IconCheck width={14} height={14} /> : null}
                  <span>Teams</span>
                  {selectedTeamIds.length > 0 ? (
                    <span className="cu-agent-access-tab__count">{selectedTeamIds.length}</span>
                  ) : null}
                </button>
              </div>
              {accessTab === 'members' ? (
                <div className="cu-workflow-access__picker cu-workflow-access__picker--inline">
                  <div data-testid="wizard-users-list">
                    <SelectionDropdown
                      id="wizard-member-picker"
                      inline
                      value={selectedUserIds}
                      onChange={setSelectedUserIds}
                      options={memberAccessOptions}
                      placeholder="Select members"
                      searchPlaceholder="Search members..."
                      selectionLabel="Selected members"
                      emptyLabel="No members available."
                      disabled={busy || directoryLoading}
                    />
                  </div>
                </div>
              ) : (
                <div className="cu-workflow-access__picker cu-workflow-access__picker--inline">
                  <div data-testid="wizard-teams-list">
                    <SelectionDropdown
                      id="wizard-team-picker"
                      inline
                      value={selectedTeamIds}
                      onChange={setSelectedTeamIds}
                      options={teamAccessOptions}
                      placeholder="Select teams"
                      searchPlaceholder="Search teams..."
                      selectionLabel="Selected teams"
                      emptyLabel="No teams available."
                      disabled={busy || directoryLoading}
                    />
                  </div>
                </div>
              )}
            </div>

            {selectedUserIds.length === 0 && selectedTeamIds.length === 0 && directoryLoadError ? (
              <p className="cu-agent-access-note" data-testid="wizard-empty-access-load-error-note">
                Directory access could not be loaded. You can continue now and grant access later
                from the agent detail page.
              </p>
            ) : selectedUserIds.length === 0 && selectedTeamIds.length === 0 ? (
              <p className="cu-agent-access-note" data-testid="wizard-empty-access-warning">
                No members or teams selected. You can continue and grant access later from the agent
                detail page.
              </p>
            ) : null}
          </div>
        )}

        {step === 3 && (
          <div className="cu-form-stack cu-agent-form-stack">
            <div className="cu-agent-access-section">
              <strong>Connectors</strong>
              <span className="cu-muted cu-agent-access-hint">
                Choose the connectors this agent can use. You can leave this empty and add
                connectors later.
              </span>
            </div>
            <div className="cu-agent-section-label">Available connectors (optional)</div>
            <div className="cu-agent-mcp-grid" role="group" aria-label="Available connectors">
              {availableMcp.map(name => (
                <CheckboxField
                  key={name}
                  checked={selectedMcp.includes(name)}
                  className="cu-agent-mcp-option"
                  label={
                    <span className="cu-agent-mcp-option__label">
                      <span className="cu-agent-mcp-option__name">{name}</span>
                      <span className="cu-agent-mcp-option__meta">Connector</span>
                    </span>
                  }
                  disabled={busy}
                  onChange={() => toggleMcp(name)}
                />
              ))}
              {availableMcp.length === 0 ? (
                <span className="cu-agent-empty-note">No connectors available.</span>
              ) : null}
            </div>
          </div>
        )}

        {error ? (
          <div className="cu-banner cu-banner--error cu-agent-flow-message">{error}</div>
        ) : null}
        {validationMessage && !canNext ? (
          <div className="cu-agent-validation-message">
            <IconAlertTriangle width={14} height={14} />
            {validationMessage}
          </div>
        ) : null}

        <div className={mode === 'page' ? 'cu-create-actions' : 'cu-modal-panel__foot'}>
          <Button
            onClick={() => setStep(s => Math.max(0, s - 1))}
            disabled={busy || step === 0}
            size="sm"
            variant="ghost"
          >
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button
              onClick={() => setStep(s => Math.min(STEPS.length - 1, s + 1))}
              disabled={busy || !canNext}
              size="sm"
              variant="primary"
            >
              Next
            </Button>
          ) : (
            <Button
              onClick={() => void submitAll()}
              disabled={busy || !canNext}
              size="sm"
              variant="primary"
            >
              {busy ? 'Saving…' : 'Create Agent'}
            </Button>
          )}
        </div>
      </CreateStepFlow>
    </>
  )

  const wizardContent =
    mode === 'page' && pageHeader ? (
      <CreateFlowPanel header={pageHeader}>{wizardBody}</CreateFlowPanel>
    ) : (
      <div
        className={
          mode === 'page' ? 'cu-agent-create-panel' : 'cu-modal-panel cu-agent-create-dialog'
        }
        role={mode === 'page' ? 'region' : 'dialog'}
        aria-labelledby="create-agent-title"
        onClick={mode === 'page' ? undefined : e => e.stopPropagation()}
      >
        {wizardBody}
      </div>
    )

  if (mode === 'page') {
    return wizardContent
  }

  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      {wizardContent}
    </div>
  )
}
