'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChannelCredentialsPanel } from '@/components/ChannelCredentialsPanel'
import type { CredentialDraft } from '@/components/ChannelCredentialsPanel/types'
import { CreateFlowPanel } from '@/components/CreateFlowPanel'
import { CreateStepFlow } from '@/components/CreateStepFlow'
import { LlmProviderConfig } from '@/components/LlmProviderConfig'
import { SelectionDropdown } from '@/components/SelectionDropdown'
import { useToast } from '@/components/Toast'
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconX } from '@/components/icons'
import { Button, CheckboxField, Field, TextInput } from '@/components/ui'
import {
  apiGet,
  apiSend,
  getAdminTeams,
  getAdminUsers,
  updateAgentTeams,
  updateAgentUsers,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { useLlmAllowedModels } from '@/lib/hooks/useLlmAllowedModels'
import { FIRST_PARTY_CHANNEL_WORKFLOW_CONTROL_SCOPES } from '@/lib/hostWorkflowControl'
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
import type {
  ChannelOption,
  ChannelProvider,
  ContextOption,
  HostWizardProps,
  NewChannelDraft,
  WizardSelectProps,
} from './types'

const CHANNEL_PROVIDER_OPTIONS: Array<{ value: ChannelProvider; label: string; meta: string }> = [
  { value: 'telegram', label: 'Telegram', meta: 'Telegram bot' },
  { value: 'slack', label: 'Slack', meta: 'Slack app' },
]

// Stateless lifecycle support remains intact in the API and existing-agent UI;
// only creation through this wizard is temporarily unavailable.
const SHOW_STATELESS_AGENT_SELECTOR = false

function createNewChannelDraft(): NewChannelDraft {
  return {
    slackBotHandle: '',
    slackReplyOnlyWhenMentioned: true,
    slackReplyInThreads: false,
    telegramBotHandle: '',
    telegramReplyOnlyWhenMentioned: true,
  }
}

function requiredCredentialKeysForChannelProvider(
  provider: ChannelProvider
): Array<keyof CredentialDraft> {
  return provider === 'telegram'
    ? ['telegram-bot-token']
    : ['slack-signing-secret', 'slack-bot-token']
}

function hasRequiredChannelCredential(
  provider: ChannelProvider,
  credentials: CredentialDraft
): boolean {
  return requiredCredentialKeysForChannelProvider(provider).every(key =>
    Boolean((credentials[key] || '').trim())
  )
}

function missingCredentialLabel(
  provider: ChannelProvider,
  credentials: CredentialDraft
): string | null {
  const missingKey = requiredCredentialKeysForChannelProvider(provider).find(
    key => !(credentials[key] || '').trim()
  )
  switch (missingKey) {
    case 'telegram-bot-token':
      return 'Telegram bot token'
    case 'slack-signing-secret':
      return 'Slack signing secret'
    case 'slack-bot-token':
      return 'Slack Bot User OAuth token'
    default:
      return null
  }
}

function isValidTelegramBotHandle(value: string): boolean {
  return /^@?[A-Za-z0-9_]{5,32}$/.test(value.trim())
}

// Asymmetric save gate (spec Topic 1b): the PRIMARY provider must be usable —
// its required credential slot(s) filled — before create is allowed. Fallbacks
// are optional and only warn, so they never enter this gate.
function primaryCredentialUsable(provider: LlmProvider, draft: Record<string, string>): boolean {
  return isProviderUsable(provider, key => (draft[key] ?? '').trim().length > 0)
}

function providerSettings(provider: ChannelProvider, draft: NewChannelDraft) {
  if (provider === 'telegram') {
    return {
      slack: [],
      telegram: [],
      telegramSettings: {
        botHandle: draft.telegramBotHandle.trim(),
        replyOnlyWhenMentioned: draft.telegramReplyOnlyWhenMentioned,
      },
    }
  }
  return {
    slack: [],
    slackSettings: {
      botHandle: draft.slackBotHandle.trim(),
      replyOnlyWhenMentioned: draft.slackReplyOnlyWhenMentioned,
      replyInThreads: draft.slackReplyInThreads,
    },
    telegram: [],
  }
}

function WizardSelect({
  className,
  disabled,
  onChange,
  options,
  placeholder,
  value,
}: WizardSelectProps) {
  const [open, setOpen] = useState(false)
  const selectedOption = options.find(option => option.value === value)

  return (
    <div
      className={cn('cu-agent-select', className)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        className="cu-agent-select__button"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className="cu-agent-select__button-copy">
          <span>{selectedOption?.label || placeholder}</span>
          {selectedOption?.meta ? (
            <span className="cu-agent-select__button-meta">{selectedOption.meta}</span>
          ) : null}
        </span>
        <span className="cu-agent-select__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="cu-agent-select__menu" role="listbox">
          {options.length === 0 ? (
            <span className="cu-agent-select__empty">No options available.</span>
          ) : (
            options.map(option => (
              <button
                key={option.value}
                type="button"
                className="cu-agent-select__option"
                data-active={value === option.value ? 'true' : 'false'}
                role="option"
                aria-selected={value === option.value}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span className="cu-agent-select__option-copy">
                  <span className="cu-agent-select__option-name">{option.label}</span>
                  {option.meta ? (
                    <span className="cu-agent-select__option-meta">{option.meta}</span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function isStepValid(
  stepIndex: number,
  state: {
    hostName: string
    contextMode: 'existing' | 'new'
    contextName: string
    selectedExistingContext: string
    selectedMcp: string[]
    channelMode: 'existing' | 'new' | 'skip'
    channelName: string
    channelProvider: ChannelProvider
    newChannelDraft: NewChannelDraft
    pendingCredentials: CredentialDraft
    selectedExistingChannel: string
    secretMode: 'existing' | 'new'
    existingSecret: string
    newSecretName: string
    llmKeyDraft: Record<string, string>
    llmPolicy: LlmPolicy | undefined
    provider: LlmProvider
    modelName: string
    selectedUserIds: string[]
    selectedTeamIds: string[]
    directoryLoadFailed: boolean
  }
): boolean {
  if (stepIndex === 0) return state.hostName.trim().length > 0
  if (stepIndex === 1) {
    if (state.contextMode === 'existing') return state.selectedExistingContext.trim().length > 0
    return state.contextName.trim().length > 0
  }
  if (stepIndex === 2) {
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
  if (stepIndex === 3) {
    return true
  }
  if (stepIndex === 4) {
    if (state.channelMode === 'skip') return true
    if (state.channelMode === 'existing') return state.selectedExistingChannel.trim().length > 0
    if (!toKebabCase(state.channelName)) return false
    if (!hasRequiredChannelCredential(state.channelProvider, state.pendingCredentials)) return false
    if (
      state.channelProvider === 'telegram' &&
      !isValidTelegramBotHandle(state.newChannelDraft.telegramBotHandle)
    ) {
      return false
    }
    if (state.channelProvider === 'slack') {
      if (!state.newChannelDraft.slackBotHandle.trim()) return false
    }
    return true
  }
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

  const [contextName, setContextName] = useState('')
  const [contextMode, setContextMode] = useState<'existing' | 'new'>('existing')
  const [selectedExistingContext, setSelectedExistingContext] = useState('')
  const [contextSelectOpen, setContextSelectOpen] = useState(false)
  const [selectedMcp, setSelectedMcp] = useState<string[]>([])
  const [existingContexts, setExistingContexts] = useState<ContextOption[]>([])
  const contextSelectRef = useRef<HTMLDivElement | null>(null)

  const [channelName, setChannelName] = useState('')
  const [channelMode, setChannelMode] = useState<'existing' | 'new' | 'skip'>('existing')
  const [channelProvider, setChannelProvider] = useState<ChannelProvider>('telegram')
  const [newChannelDraft, setNewChannelDraft] = useState<NewChannelDraft>(() =>
    createNewChannelDraft()
  )
  const [selectedExistingChannel, setSelectedExistingChannel] = useState('')
  const [channelSelectOpen, setChannelSelectOpen] = useState(false)
  const [existingChannels, setExistingChannels] = useState<ChannelOption[]>([])
  const channelSelectRef = useRef<HTMLDivElement | null>(null)
  const [pendingCredentials, setPendingCredentials] = useState<CredentialDraft>({})

  // Per-host secret: default to a new, auto-named Secret ("this agent's
  // credentials") so the operator never has to name a Kubernetes Secret; reusing
  // an existing shared Secret stays a first-class choice (spec Topic 1b R4).
  const [secretMode, setSecretMode] = useState<'existing' | 'new'>('new')
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
            meta: `${secret.metadata?.namespace || HOST_NAMESPACE} · ${providerSummary}`,
          }
        })
        .filter(option => option !== null)
        .sort((left, right) => left.value.localeCompare(right.value)),
    [existingSecrets]
  )
  const selectedContextOption = useMemo(
    () =>
      existingContexts.find(ctx => `${ctx.namespace}/${ctx.name}` === selectedExistingContext) ||
      null,
    [existingContexts, selectedExistingContext]
  )
  const selectedContextLabel = selectedContextOption?.contextId || 'Select context...'
  const selectedChannelOption = useMemo(
    () =>
      existingChannels.find(
        channel => `${channel.namespace}/${channel.name}` === selectedExistingChannel
      ) || null,
    [existingChannels, selectedExistingChannel]
  )
  const selectedChannelLabel = selectedChannelOption?.name || 'Select channel...'
  const providerModelOptions = useMemo(
    () => getModelOptions(allowedCatalog, provider),
    [allowedCatalog, provider]
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

  const visibleChannelTypes = useMemo(() => [channelProvider], [channelProvider])

  const canNext = useMemo(() => {
    return isStepValid(step, {
      hostName,
      contextMode,
      contextName,
      selectedExistingContext,
      selectedMcp,
      channelMode,
      channelName,
      channelProvider,
      newChannelDraft,
      pendingCredentials,
      selectedExistingChannel,
      secretMode,
      existingSecret,
      newSecretName,
      llmKeyDraft,
      llmPolicy,
      provider,
      modelName,
      selectedUserIds,
      selectedTeamIds,
      directoryLoadFailed: directoryLoadError.length > 0,
    })
  }, [
    step,
    hostName,
    contextMode,
    contextName,
    selectedExistingContext,
    selectedMcp,
    channelMode,
    channelName,
    channelProvider,
    newChannelDraft,
    pendingCredentials,
    selectedExistingChannel,
    secretMode,
    existingSecret,
    newSecretName,
    llmKeyDraft,
    llmPolicy,
    provider,
    modelName,
    selectedUserIds,
    selectedTeamIds,
    directoryLoadError,
  ])

  const loadDirectory = useCallback(async () => {
    setDirectoryLoading(true)
    setDirectoryLoadError('')
    setError('')
    try {
      const [usersData, teamsData, contextsData, channelsData] = await Promise.all([
        getAdminUsers(''),
        getAdminTeams(),
        apiGet('/api/v1/admin/contexts') as Promise<{
          items?: Array<{
            metadata?: { name?: string; namespace?: string }
            spec?: { contextId?: string; mcpServers?: unknown[] }
          }>
        }>,
        apiGet('/api/v1/admin/communication-channels') as Promise<{
          items?: Array<{
            metadata?: { name?: string; namespace?: string }
            spec?: Record<string, unknown>
          }>
        }>,
      ])
      if (!mountedRef.current) return
      setUsers(Array.isArray(usersData.items) ? usersData.items : [])
      setTeams(Array.isArray(teamsData.items) ? teamsData.items : [])
      const contextOptions = (contextsData.items || [])
        .map(ctx => ({
          name: String(ctx.metadata?.name || '').trim(),
          namespace: String(ctx.metadata?.namespace || 'default').trim(),
          contextId: String(ctx.spec?.contextId || ctx.metadata?.name || '').trim(),
          mcpServers: Array.isArray(ctx.spec?.mcpServers)
            ? ctx.spec?.mcpServers
                .map(String)
                .map(v => v.trim())
                .filter(Boolean)
            : [],
        }))
        .filter(ctx => ctx.name && ctx.contextId)
        .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
      setExistingContexts(contextOptions)
      const channelOptions = (channelsData.items || [])
        .map(channel => ({
          name: String(channel.metadata?.name || '').trim(),
          namespace: String(channel.metadata?.namespace || 'default').trim(),
          spec: (channel.spec || {}) as Record<string, unknown>,
        }))
        .filter(channel => channel.name)
        .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
      setExistingChannels(channelOptions)
    } catch (e) {
      if (!mountedRef.current) return
      const message =
        e instanceof Error
          ? `Failed to load users/teams/contexts: ${e.message}. You may not be able to grant access from this wizard — retry or check your session.`
          : 'Failed to load users/teams/contexts. You may not be able to grant access from this wizard.'
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
            contextMode,
            contextName,
            selectedExistingContext,
            selectedMcp,
            channelMode,
            channelName,
            channelProvider,
            newChannelDraft,
            pendingCredentials,
            selectedExistingChannel,
            secretMode,
            existingSecret,
            newSecretName,
            llmKeyDraft,
            llmPolicy,
            provider,
            modelName,
            selectedUserIds,
            selectedTeamIds,
            directoryLoadFailed: directoryLoadError.length > 0,
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
      contextMode,
      contextName,
      selectedExistingContext,
      selectedMcp,
      channelMode,
      channelName,
      channelProvider,
      newChannelDraft,
      pendingCredentials,
      selectedExistingChannel,
      secretMode,
      existingSecret,
      newSecretName,
      llmKeyDraft,
      llmPolicy,
      provider,
      modelName,
      selectedUserIds,
      selectedTeamIds,
      directoryLoadError,
    ]
  )

  const validationMessage = useMemo(() => {
    if (step === 0 && !hostName.trim()) return 'Agent name is required.'
    if (step === 1 && contextMode === 'existing' && !selectedExistingContext.trim())
      return 'Select an existing context.'
    if (step === 1 && contextMode === 'new' && !contextName.trim())
      return 'Context name is required.'
    if (step === 2 && !modelName.trim()) return 'Model name is required.'
    if (step === 2 && secretMode === 'existing' && !existingSecret.trim())
      return 'Select an existing secret.'
    if (step === 2 && secretMode === 'new' && !toKebabCase(newSecretName)) {
      return 'For a new secret, set a name.'
    }
    if (step === 2 && secretMode === 'new' && !primaryCredentialUsable(provider, llmKeyDraft)) {
      return `Add the ${getProviderLabel(provider)} credential for the primary model.`
    }
    if (step === 2 && secretMode === 'new') {
      const projected = projectCredentialDraft(
        llmKeyDraft,
        getActiveCredentialKeys(provider, llmPolicy)
      )
      const slotErrors = validateLlmSecretData(projected)
      if (slotErrors.length > 0) return slotErrors[0]
    }
    if (step === 4 && channelMode === 'existing' && !selectedExistingChannel.trim())
      return 'Select an existing channel or skip channel setup.'
    if (step === 4 && channelMode === 'new' && !toKebabCase(channelName))
      return 'CommunicationChannel name is required, or skip channel setup.'
    if (
      step === 4 &&
      channelMode === 'new' &&
      !hasRequiredChannelCredential(channelProvider, pendingCredentials)
    )
      return `${missingCredentialLabel(channelProvider, pendingCredentials) || 'Channel credential'} is required, or skip channel setup.`
    if (
      step === 4 &&
      channelMode === 'new' &&
      channelProvider === 'telegram' &&
      !isValidTelegramBotHandle(newChannelDraft.telegramBotHandle)
    )
      return 'A valid Telegram bot handle is required, or skip channel setup.'
    if (
      step === 4 &&
      channelMode === 'new' &&
      channelProvider === 'slack' &&
      !newChannelDraft.slackBotHandle.trim()
    )
      return 'Slack App Name is required, or skip channel setup.'
    return ''
  }, [
    step,
    hostName,
    contextMode,
    contextName,
    selectedExistingContext,
    selectedMcp,
    channelMode,
    channelName,
    channelProvider,
    newChannelDraft,
    pendingCredentials,
    selectedExistingChannel,
    secretMode,
    existingSecret,
    newSecretName,
    llmKeyDraft,
    llmPolicy,
    provider,
    modelName,
    selectedUserIds,
    selectedTeamIds,
  ])

  async function upsertResource(
    pluralPath: string,
    name: string,
    createBody: unknown,
    updateBody: unknown
  ) {
    try {
      await apiSend('PUT', `/api/v1/${pluralPath}/${encodeURIComponent(name)}`, updateBody)
    } catch {
      await apiSend('POST', `/api/v1/${pluralPath}`, createBody)
    }
  }

  function resetForm() {
    setStep(0)
    setError('')

    setHostName('')
    setContextName('')
    setContextMode('existing')
    setSelectedExistingContext('')
    setContextSelectOpen(false)
    setSelectedMcp([])
    setChannelName('')
    setChannelMode('existing')
    setChannelProvider('telegram')
    setNewChannelDraft(createNewChannelDraft())
    setSelectedExistingChannel('')
    setChannelSelectOpen(false)
    setPendingCredentials({})
    setSecretMode('new')
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

  function selectExistingContext(context: ContextOption) {
    setSelectedExistingContext(`${context.namespace}/${context.name}`)
    setContextSelectOpen(false)
  }

  function selectExistingChannel(channel: ChannelOption) {
    setSelectedExistingChannel(`${channel.namespace}/${channel.name}`)
    setChannelSelectOpen(false)
  }

  function handleChannelProviderChange(provider: ChannelProvider) {
    setChannelProvider(provider)
    setPendingCredentials({})
    setError('')
  }

  async function submitAll(options: { skipChannels?: boolean } = {}) {
    setBusy(true)
    setError('')
    try {
      const shouldSkipChannels = options.skipChannels || channelMode === 'skip'
      const normalizedHostName = toKebabCase(hostName)
      const normalizedContextName = toKebabCase(contextName)
      const resolvedContextName =
        contextMode === 'existing' ? selectedContextOption?.contextId || '' : normalizedContextName
      const normalizedChannelName = toKebabCase(channelName)
      const resolvedChannelName =
        channelMode === 'existing' ? selectedChannelOption?.name || '' : normalizedChannelName
      const channelRefs = shouldSkipChannels ? [] : [resolvedChannelName]
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
        await apiSend('POST', '/api/v1/admin/secrets', {
          name: normalizedSecretName,
          namespace: hostNamespace,
          labels: {
            [HOST_SECRET_LABEL_KEY]: HOST_SECRET_LABEL_VALUE,
          },
          stringData,
        })
      }

      if (contextMode === 'new') {
        await upsertResource(
          'admin/contexts',
          normalizedContextName,
          {
            metadata: { name: normalizedContextName },
            spec: {
              contextId: normalizedContextName,
              description: `Context for agent ${normalizedHostName}`,
              mcpServers: Array.from(new Set(selectedMcp)),
            },
          },
          {
            spec: {
              contextId: normalizedContextName,
              description: `Context for agent ${normalizedHostName}`,
              mcpServers: Array.from(new Set(selectedMcp)),
            },
          }
        )
      }

      if (!shouldSkipChannels && channelMode === 'new') {
        const cleanedCredentials: CredentialDraft = {}
        for (const [key, value] of Object.entries(pendingCredentials) as Array<
          [keyof CredentialDraft, string | undefined]
        >) {
          const trimmed = (value || '').trim()
          if (trimmed.length > 0) cleanedCredentials[key] = trimmed
        }
        const channelAccess = {
          users: Array.from(new Set(selectedUserIds)),
          teams: Array.from(new Set(selectedTeamIds)),
        }
        const channelSpec = {
          hostRef: normalizedHostName,
          access: channelAccess,
          ...providerSettings(channelProvider, newChannelDraft),
        }

        await upsertResource(
          'admin/communication-channels',
          normalizedChannelName,
          {
            metadata: { name: normalizedChannelName },
            spec: channelSpec,
            credentials: cleanedCredentials,
          },
          {
            spec: channelSpec,
          }
        )
      } else if (!shouldSkipChannels && channelMode === 'existing' && selectedChannelOption) {
        await apiSend(
          'PUT',
          `/api/v1/admin/communication-channels/${encodeURIComponent(selectedChannelOption.name)}`,
          {
            spec: {
              ...selectedChannelOption.spec,
              hostRef: normalizedHostName,
              access: {
                users: Array.from(new Set(selectedUserIds)),
                teams: Array.from(new Set(selectedTeamIds)),
              },
            },
          }
        )
      }

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
        contextRef: resolvedContextName,
        secretRef: secretMode === 'existing' ? existingSecret : normalizedSecretName,
        channels: channelRefs,
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
        ...(channelRefs.length > 0
          ? { workflowControl: { scopes: [...FIRST_PARTY_CHANNEL_WORKFLOW_CONTROL_SCOPES] } }
          : {}),
      }

      await upsertResource(
        'admin/hosts',
        normalizedHostName,
        {
          metadata: { name: normalizedHostName },
          spec: hostSpec,
        },
        {
          spec: hostSpec,
        }
      )

      // Associate authorized users and teams with the new agent in a single
      // atomic call each, rather than looping N×(GET+PUT) per selection.
      // Uses the agent-centric endpoints PUT /admin/agents/:name/users|teams.
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
                  <span className="cu-agent-input-shell__status" aria-label="Valid agent name">
                    <IconCheck width={16} height={16} />
                  </span>
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
            <div className="cu-agent-info-card">
              <IconInfoCircle width={16} height={16} />
              <div>
                <strong>Naming conventions</strong>
                <p>
                  Use lowercase letters, numbers, and hyphens only. Must start with a letter and be
                  3-63 characters long.
                </p>
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="cu-form-stack cu-agent-form-stack">
            <div className="cu-agent-radio-group">
              <label className="cu-agent-radio cu-agent-radio--card">
                <input
                  type="radio"
                  checked={contextMode === 'existing'}
                  onChange={() => setContextMode('existing')}
                />
                <span className="cu-agent-radio__copy">
                  <span className="cu-agent-radio__title">Use existing context</span>
                  <span className="cu-agent-radio__description">
                    Select a saved context and reuse its MCP server attachments.
                  </span>
                </span>
              </label>
              <label className="cu-agent-radio cu-agent-radio--card">
                <input
                  type="radio"
                  checked={contextMode === 'new'}
                  onChange={() => setContextMode('new')}
                />
                <span className="cu-agent-radio__copy">
                  <span className="cu-agent-radio__title">Create new context</span>
                  <span className="cu-agent-radio__description">
                    Create a context for this agent. MCP servers can be attached now or later.
                  </span>
                </span>
              </label>
            </div>
            {contextMode === 'existing' ? (
              <>
                <div
                  className="cu-agent-select"
                  ref={contextSelectRef}
                  onBlur={event => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      setContextSelectOpen(false)
                    }
                  }}
                >
                  <button
                    type="button"
                    className="cu-agent-select__button"
                    aria-expanded={contextSelectOpen}
                    aria-haspopup="listbox"
                    onClick={() => setContextSelectOpen(open => !open)}
                  >
                    <span>{selectedContextLabel}</span>
                    <span className="cu-agent-select__chevron" aria-hidden="true" />
                  </button>
                  {contextSelectOpen ? (
                    <div className="cu-agent-select__menu" role="listbox">
                      {existingContexts.length === 0 ? (
                        <span className="cu-agent-select__empty">No contexts available.</span>
                      ) : (
                        existingContexts.map(ctx => {
                          const value = `${ctx.namespace}/${ctx.name}`
                          return (
                            <button
                              key={value}
                              type="button"
                              className="cu-agent-select__option"
                              data-active={selectedExistingContext === value ? 'true' : 'false'}
                              role="option"
                              aria-selected={selectedExistingContext === value}
                              onClick={() => selectExistingContext(ctx)}
                            >
                              {ctx.contextId}
                            </button>
                          )
                        })
                      )}
                    </div>
                  ) : null}
                </div>
                {selectedContextOption && (
                  <div className="cu-agent-option-meta">
                    MCP servers:{' '}
                    {selectedContextOption.mcpServers.length > 0
                      ? selectedContextOption.mcpServers.join(', ')
                      : 'none'}
                  </div>
                )}
              </>
            ) : (
              <>
                <Field
                  description="Automatically formatted to lowercase with hyphens."
                  label="Context name"
                >
                  <TextInput
                    value={contextName}
                    onChange={e => setContextName(toKebabInput(e.target.value))}
                    placeholder="context-name"
                  />
                </Field>
                <div className="cu-agent-section-label">MCP servers (optional)</div>
                <div className="cu-agent-mcp-grid">
                  {availableMcp.map(name => (
                    <CheckboxField
                      key={name}
                      checked={selectedMcp.includes(name)}
                      className="cu-agent-mcp-option"
                      label={
                        <span className="cu-agent-mcp-option__label">
                          <span className="cu-agent-mcp-option__name">{name}</span>
                          <span className="cu-agent-mcp-option__meta">MCP server</span>
                        </span>
                      }
                      onChange={() => toggleMcp(name)}
                    />
                  ))}
                  {availableMcp.length === 0 ? (
                    <span className="cu-agent-empty-note">No MCP servers available.</span>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="cu-form-stack cu-agent-form-stack">
            <div className="cu-agent-review">
              Review: Agent <b>{toKebabCase(hostName) || '-'}</b>, Context{' '}
              <b>
                {contextMode === 'existing'
                  ? selectedContextOption?.contextId || '-'
                  : toKebabCase(contextName) || '-'}
              </b>
              , Model <b>{modelName || '-'}</b>, Secret{' '}
              <b>
                {secretMode === 'existing'
                  ? existingSecret || '-'
                  : toKebabCase(newSecretName) || '-'}
              </b>
              , Channel{' '}
              <b>
                {channelMode === 'existing'
                  ? selectedChannelOption?.name || '-'
                  : channelMode === 'new'
                    ? toKebabCase(channelName) || '-'
                    : 'skipped'}
              </b>
            </div>
            <div className="cu-agent-radio-group">
              <label className="cu-agent-radio cu-agent-radio--card">
                <input
                  type="radio"
                  checked={channelMode === 'existing'}
                  onChange={() => setChannelMode('existing')}
                />
                <span className="cu-agent-radio__copy">
                  <span className="cu-agent-radio__title">Use existing channel</span>
                  <span className="cu-agent-radio__description">
                    Attach a saved external channel to this agent.
                  </span>
                </span>
              </label>
              <label className="cu-agent-radio cu-agent-radio--card">
                <input
                  type="radio"
                  checked={channelMode === 'new'}
                  onChange={() => setChannelMode('new')}
                />
                <span className="cu-agent-radio__copy">
                  <span className="cu-agent-radio__title">Create new channel</span>
                  <span className="cu-agent-radio__description">
                    Configure a new external channel and attach it immediately.
                  </span>
                </span>
              </label>
            </div>
            {channelMode === 'existing' ? (
              <div
                className="cu-agent-select"
                ref={channelSelectRef}
                onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    setChannelSelectOpen(false)
                  }
                }}
              >
                <button
                  type="button"
                  className="cu-agent-select__button"
                  aria-expanded={channelSelectOpen}
                  aria-haspopup="listbox"
                  onClick={() => setChannelSelectOpen(open => !open)}
                >
                  <span>{selectedChannelLabel}</span>
                  <span className="cu-agent-select__chevron" aria-hidden="true" />
                </button>
                {channelSelectOpen ? (
                  <div className="cu-agent-select__menu" role="listbox">
                    {existingChannels.length === 0 ? (
                      <span className="cu-agent-select__empty">No channels available.</span>
                    ) : (
                      existingChannels.map(channel => {
                        const value = `${channel.namespace}/${channel.name}`
                        return (
                          <button
                            key={value}
                            type="button"
                            className="cu-agent-select__option"
                            data-active={selectedExistingChannel === value ? 'true' : 'false'}
                            role="option"
                            aria-selected={selectedExistingChannel === value}
                            onClick={() => selectExistingChannel(channel)}
                          >
                            <span className="cu-agent-select__option-copy">
                              <span className="cu-agent-select__option-name">{channel.name}</span>
                              <span className="cu-agent-select__option-meta">
                                {channel.namespace}
                              </span>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                <Field
                  description="Automatically formatted to lowercase with hyphens."
                  label="CommunicationChannel name"
                >
                  <TextInput
                    value={channelName}
                    onChange={e => setChannelName(toKebabInput(e.target.value))}
                    placeholder="channel-name"
                  />
                </Field>
                <div className="cu-agent-access-section">
                  <strong>Provider</strong>
                  <span className="cu-muted cu-agent-access-hint">
                    Users will confirm the Telegram chat or Slack conversation after this channel
                    exists.
                  </span>
                  <WizardSelect
                    value={channelProvider}
                    placeholder="Select provider..."
                    options={CHANNEL_PROVIDER_OPTIONS}
                    onChange={nextValue =>
                      handleChannelProviderChange(nextValue as ChannelProvider)
                    }
                  />
                  {channelProvider === 'telegram' ? (
                    <>
                      <Field
                        description="Public bot username, with or without the leading @."
                        label={
                          <>
                            Telegram bot handle{' '}
                            <span
                              className="cu-help-tooltip"
                              tabIndex={0}
                              aria-label="We use this handle to show users which Telegram bot to message when connecting their account or a group."
                              data-tooltip="We use this handle to show users which Telegram bot to message when connecting their account or a group."
                            >
                              ?
                            </span>
                          </>
                        }
                      >
                        <TextInput
                          value={newChannelDraft.telegramBotHandle}
                          onChange={e =>
                            setNewChannelDraft(current => ({
                              ...current,
                              telegramBotHandle: e.target.value,
                            }))
                          }
                          placeholder="@your_bot"
                          autoComplete="off"
                        />
                      </Field>
                      <CheckboxField
                        checked={newChannelDraft.telegramReplyOnlyWhenMentioned}
                        description="In groups and supergroups, process messages only when the bot is mentioned or replied to. Private chats are unaffected."
                        label="Only respond when mentioned in groups"
                        onChange={e =>
                          setNewChannelDraft(current => ({
                            ...current,
                            telegramReplyOnlyWhenMentioned: e.target.checked,
                          }))
                        }
                      />
                    </>
                  ) : (
                    <>
                      <div className="cu-banner cu-banner--info">
                        Install your Slack app in the workspace first. Store the Signing Secret and
                        Bot User OAuth token below. The workspace is detected when a user verifies a
                        Slack conversation.
                      </div>
                      <Field
                        description="Shown to users so they know which Slack App to message."
                        label={
                          <>
                            Slack App Name{' '}
                            <span
                              className="cu-help-tooltip"
                              tabIndex={0}
                              aria-label="We use this name to show users which Slack App to message"
                              data-tooltip="We use this name to show users which Slack App to message"
                            >
                              ?
                            </span>
                          </>
                        }
                      >
                        <TextInput
                          value={newChannelDraft.slackBotHandle}
                          onChange={e =>
                            setNewChannelDraft(current => ({
                              ...current,
                              slackBotHandle: e.target.value,
                            }))
                          }
                          placeholder="Your Slack App"
                          autoComplete="off"
                        />
                      </Field>
                      <CheckboxField
                        checked={newChannelDraft.slackReplyOnlyWhenMentioned}
                        description="Process Slack messages only when the app bot is mentioned."
                        label="Only respond when mentioned"
                        onChange={e =>
                          setNewChannelDraft(current => ({
                            ...current,
                            slackReplyOnlyWhenMentioned: e.target.checked,
                          }))
                        }
                      />
                      <CheckboxField
                        checked={newChannelDraft.slackReplyInThreads}
                        description={
                          <>
                            Send app responses in a Slack thread and keep responses in that thread
                            until a new top-level message starts a new thread.{' '}
                            <span
                              className="cu-help-tooltip"
                              tabIndex={0}
                              aria-label="When enabled, app responses are posted in a Slack thread and follow-up messages in that thread continue there. New top-level messages start a new thread."
                              data-tooltip="When enabled, app responses are posted in a Slack thread and follow-up messages in that thread continue there. New top-level messages start a new thread."
                            >
                              ?
                            </span>
                          </>
                        }
                        label="Reply in threads"
                        onChange={e =>
                          setNewChannelDraft(current => ({
                            ...current,
                            slackReplyInThreads: e.target.checked,
                          }))
                        }
                      />
                    </>
                  )}
                </div>
                <ChannelCredentialsPanel
                  ccName={channelName.trim()}
                  pending={true}
                  presentation="inline"
                  onPendingChange={setPendingCredentials}
                  visibleChannelTypes={visibleChannelTypes}
                />
                <p className="cu-agent-access-note">
                  Channel access will use the members and teams selected in the Access step:{' '}
                  {selectedUserIds.length} member{selectedUserIds.length === 1 ? '' : 's'} and{' '}
                  {selectedTeamIds.length} team{selectedTeamIds.length === 1 ? '' : 's'}.
                </p>
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="cu-form-stack cu-agent-form-stack">
            <div className="cu-agent-access-section">
              <strong>Credentials</strong>
              <span className="cu-muted cu-agent-access-hint">
                Store this agent&apos;s own LLM credentials, or use a shared Kubernetes Secret.
              </span>
              <div className="cu-agent-radio-group">
                <label className="cu-agent-radio cu-agent-radio--card">
                  <input
                    type="radio"
                    checked={secretMode === 'existing'}
                    onChange={() => setSecretMode('existing')}
                  />
                  <span className="cu-agent-radio__copy">
                    <span className="cu-agent-radio__title">Use an existing Secret</span>
                    <span className="cu-agent-radio__description">
                      Select a saved Kubernetes Secret that already contains LLM API keys.
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
                    <span className="cu-agent-radio__title">New credential</span>
                    <span className="cu-agent-radio__description">
                      Create a new Secret for this agent. Its name is derived from the agent name.
                    </span>
                  </span>
                </label>
              </div>
              {secretMode === 'existing' ? (
                <WizardSelect
                  value={existingSecret}
                  placeholder="Select secret..."
                  options={secretOptions}
                  onChange={setExistingSecret}
                />
              ) : (
                <Field
                  description="Auto-named from the agent — edit if you prefer a different name."
                  label="Secret name"
                >
                  <span className="cu-agent-input-shell">
                    <TextInput
                      value={newSecretName}
                      onChange={e => {
                        setSecretNameTouched(true)
                        setNewSecretName(toKebabInput(e.target.value))
                      }}
                      placeholder="secret-name"
                    />
                    <span
                      className={cn(
                        'cu-agent-input-shell__status',
                        !toKebabCase(newSecretName) && 'cu-agent-input-shell__status--empty'
                      )}
                      aria-label={
                        toKebabCase(newSecretName) ? 'Valid secret name' : 'Secret name empty'
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

        {step === 3 && (
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
            <>
              <Button
                onClick={() => void submitAll({ skipChannels: true })}
                disabled={busy}
                size="sm"
                variant="ghost"
              >
                Skip channel setup
              </Button>
              <Button
                onClick={() => void submitAll()}
                disabled={busy || !canNext}
                size="sm"
                variant="primary"
              >
                {busy ? 'Saving…' : 'Create Agent'}
              </Button>
            </>
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
