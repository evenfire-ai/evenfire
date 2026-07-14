'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { ChannelCredentialsPanel } from '@components/ChannelCredentialsPanel'
import type { CredentialDraft } from '@components/ChannelCredentialsPanel/types'
import { CommunicationChannelAccessSelector } from '@components/CommunicationChannelAccessSelector'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconBroadcast } from '@components/Sidebar/icons'
import { TabBar } from '@components/TabBar'
import { useToast } from '@components/Toast'
import { Button, Field, TextInput } from '@components/ui'
import { apiGet, apiSend } from '@lib/api'
import type { ChannelType } from '@lib/channelTypes'
import { toKebabCase, toKebabInput } from '@lib/string'

type HostItem = {
  metadata?: { name?: string }
}

type ChannelProvider = Extract<ChannelType, 'telegram' | 'slack'>

type DraftState = {
  accessTeamIds: string[]
  accessUserIds: string[]
  hostRef: string
  slackBotHandle: string
  slackReplyOnlyWhenMentioned: boolean
  slackReplyInThreads: boolean
  telegramBotHandle: string
  telegramReplyOnlyWhenMentioned: boolean
}

const STEPS = ['Channel', 'Provider'] as const
const CHANNEL_PROVIDERS: readonly ChannelProvider[] = ['telegram', 'slack'] as const

const STEP_DETAILS = [
  {
    description: 'Name and assign the channel',
    title: 'Channel identity',
    subtitle: 'Choose the Kubernetes identity and agent that owns this channel.',
  },
  {
    description: 'Credentials and access',
    title: 'Provider setup',
    subtitle: 'Select a provider, add write-only credentials, and grant chat access.',
  },
] as const

function labelForProvider(type: ChannelProvider): string {
  return type === 'telegram' ? 'Telegram' : 'Slack'
}

function requiredCredentialKeysForProvider(type: ChannelProvider): Array<keyof CredentialDraft> {
  return type === 'telegram' ? ['telegram-bot-token'] : ['slack-signing-secret', 'slack-bot-token']
}

function credentialLabel(key: keyof CredentialDraft): string {
  switch (key) {
    case 'telegram-bot-token':
      return 'Telegram bot token'
    case 'slack-signing-secret':
      return 'Slack signing secret'
    case 'slack-bot-token':
      return 'Slack Bot User OAuth token'
    default:
      return String(key)
  }
}

function providerSettings(provider: ChannelProvider, draft: DraftState) {
  if (provider === 'telegram') {
    return {
      telegram: [],
      telegramSettings: {
        botHandle: draft.telegramBotHandle.trim(),
        replyOnlyWhenMentioned: draft.telegramReplyOnlyWhenMentioned,
      },
      slack: [],
    }
  }
  return {
    telegram: [],
    slack: [],
    slackSettings: {
      botHandle: draft.slackBotHandle.trim(),
      replyOnlyWhenMentioned: draft.slackReplyOnlyWhenMentioned,
      replyInThreads: draft.slackReplyInThreads,
    },
  }
}

export default function CreateCommunicationChannelPage() {
  const router = useRouter()
  const { showToast } = useToast()

  const [loadingHosts, setLoadingHosts] = useState(true)
  const [hosts, setHosts] = useState<HostItem[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState(0)

  const [channelName, setChannelName] = useState('')
  const [activeProvider, setActiveProvider] = useState<ChannelProvider>('telegram')
  const [draft, setDraft] = useState<DraftState>({
    accessTeamIds: [],
    accessUserIds: [],
    hostRef: '',
    slackBotHandle: '',
    slackReplyOnlyWhenMentioned: false,
    slackReplyInThreads: false,
    telegramBotHandle: '',
    telegramReplyOnlyWhenMentioned: true,
  })
  const [pendingCredentials, setPendingCredentials] = useState<CredentialDraft>({})

  const visibleChannelTypes = useMemo<ChannelType[]>(() => [activeProvider], [activeProvider])

  useEffect(() => {
    async function loadHosts() {
      setLoadingHosts(true)
      setError('')
      try {
        const response = (await apiGet('/api/v1/admin/hosts')) as { items?: HostItem[] }
        setHosts(response.items || [])
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load hosts')
      } finally {
        setLoadingHosts(false)
      }
    }

    void loadHosts()
  }, [])

  function updateHostRef(hostRef: string) {
    setDraft(current => ({
      ...current,
      accessTeamIds: current.hostRef === hostRef ? current.accessTeamIds : [],
      accessUserIds: current.hostRef === hostRef ? current.accessUserIds : [],
      hostRef,
    }))
  }

  function validateIdentityStep() {
    const normalizedChannelName = toKebabCase(channelName)
    if (!normalizedChannelName) {
      setError('Channel name is required.')
      return false
    }
    if (normalizedChannelName !== channelName) setChannelName(normalizedChannelName)
    if (!draft.hostRef.trim()) {
      setError('Agent reference is required.')
      return false
    }
    setError('')
    return true
  }

  function handleContinue() {
    if (validateIdentityStep()) setStep(1)
  }

  function handleProviderChange(nextProvider: ChannelProvider) {
    setActiveProvider(nextProvider)
    setPendingCredentials({})
    setError('')
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step === 0) {
      handleContinue()
      return
    }
    await handleCreateChannel()
  }

  async function handleCreateChannel() {
    if (!validateIdentityStep()) return

    for (const credentialKey of requiredCredentialKeysForProvider(activeProvider)) {
      const selectedValue = (pendingCredentials[credentialKey] || '').trim()
      if (!selectedValue) {
        setError(`${credentialLabel(credentialKey)} is required.`)
        return
      }
    }
    if (
      activeProvider === 'telegram' &&
      !/^@?[A-Za-z0-9_]{5,32}$/.test(draft.telegramBotHandle.trim())
    ) {
      setError('A valid Telegram bot handle is required.')
      return
    }
    if (activeProvider === 'slack' && !draft.slackBotHandle.trim()) {
      setError('Slack App Name is required.')
      return
    }

    setSaving(true)
    setError('')
    try {
      const normalizedChannelName = toKebabCase(channelName)
      const cleanedCredentials: CredentialDraft = {}
      for (const [key, value] of Object.entries(pendingCredentials) as Array<
        [keyof CredentialDraft, string | undefined]
      >) {
        const trimmed = (value || '').trim()
        if (trimmed.length > 0) cleanedCredentials[key] = trimmed
      }

      await apiSend('POST', '/api/v1/admin/communication-channels', {
        metadata: {
          name: normalizedChannelName,
        },
        spec: {
          hostRef: draft.hostRef.trim(),
          access: {
            users: draft.accessUserIds,
            teams: draft.accessTeamIds,
          },
          ...providerSettings(activeProvider, draft),
        },
        credentials: cleanedCredentials,
      })
      showToast('Communication channel created.', { tone: 'success' })
      router.push('/communication-channels')
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'Failed to create communication channel'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconBroadcast />}
              title="Create communication channel"
              subtitle="Define a bot channel and grant agent-scoped chat access."
              backLabel="Back to channels"
              onBack={() => router.push('/communication-channels')}
              backDisabled={saving}
            />
          }
        >
          <form className="cu-channel-create-panel" onSubmit={handleSubmit}>
            <CreateStepFlow
              ariaLabel="Create channel steps"
              currentStep={step}
              onStepChange={setStep}
              steps={STEP_DETAILS}
              stepLabels={STEPS}
              titleId="create-channel-title"
            >
              {step === 0 ? (
                <div className="cu-form-stack cu-agent-form-stack">
                  <Field
                    description="Automatically formatted to lowercase with hyphens."
                    htmlFor="ch-name"
                    label="Channel name"
                    required
                  >
                    <TextInput
                      id="ch-name"
                      value={channelName}
                      onChange={event => setChannelName(toKebabInput(event.target.value))}
                      placeholder="channel-name (e.g. telegram-channel)"
                      disabled={saving}
                      autoFocus
                    />
                  </Field>

                  <Field
                    description="This communication channel belongs to this agent."
                    htmlFor="ch-host"
                    label="Agent reference"
                    required
                  >
                    {loadingHosts ? (
                      <span className="cu-muted cu-muted-note--compact">Loading agents...</span>
                    ) : (
                      <SelectionDropdown
                        id="ch-host"
                        multiple={false}
                        value={draft.hostRef ? [draft.hostRef] : []}
                        onChange={next => updateHostRef(next[0] || '')}
                        options={hosts
                          .map(host => host.metadata?.name || '')
                          .filter(Boolean)
                          .map(hostName => ({
                            value: hostName,
                            label: hostName,
                          }))}
                        placeholder="Select an agent..."
                        searchPlaceholder="Search agents..."
                        emptyLabel="No available agents."
                        disabled={saving}
                      />
                    )}
                  </Field>
                </div>
              ) : (
                <div className="cu-form-stack cu-agent-form-stack--wide">
                  <TabBar<ChannelProvider>
                    ariaLabel="Communication channel provider"
                    activeValue={activeProvider}
                    className="cu-tabs--flush"
                    onChange={handleProviderChange}
                    options={CHANNEL_PROVIDERS.map(type => ({
                      value: type,
                      label: labelForProvider(type),
                      disabled: saving,
                    }))}
                  />

                  {activeProvider === 'telegram' ? (
                    <ProviderPanel
                      provider="telegram"
                      checked={draft.telegramReplyOnlyWhenMentioned}
                      disabled={saving}
                      onCheckedChange={checked =>
                        setDraft(current => ({
                          ...current,
                          telegramReplyOnlyWhenMentioned: checked,
                        }))
                      }
                    >
                      <Field
                        description="Public bot username, with or without the leading @."
                        htmlFor="telegram-bot-handle"
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
                        required
                      >
                        <TextInput
                          id="telegram-bot-handle"
                          value={draft.telegramBotHandle}
                          onChange={event =>
                            setDraft(current => ({
                              ...current,
                              telegramBotHandle: event.target.value,
                            }))
                          }
                          placeholder="@your_bot"
                          disabled={saving}
                          autoComplete="off"
                        />
                      </Field>
                      <ChannelCredentialsPanel
                        ccName={channelName.trim()}
                        pending={true}
                        presentation="inline"
                        onPendingChange={setPendingCredentials}
                        visibleChannelTypes={visibleChannelTypes}
                      />
                    </ProviderPanel>
                  ) : (
                    <ProviderPanel
                      provider="slack"
                      description="Install your Slack app in the workspace, then paste the Signing Secret and Bot User OAuth token. The workspace is detected when a user verifies a Slack conversation."
                      checked={draft.slackReplyOnlyWhenMentioned}
                      disabled={saving}
                      onCheckedChange={checked =>
                        setDraft(current => ({
                          ...current,
                          slackReplyOnlyWhenMentioned: checked,
                        }))
                      }
                      replyInThreads={draft.slackReplyInThreads}
                      onReplyInThreadsChange={checked =>
                        setDraft(current => ({
                          ...current,
                          slackReplyInThreads: checked,
                        }))
                      }
                    >
                      <Field
                        description="Shown to users so they know which Slack App to message."
                        htmlFor="slack-bot-handle"
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
                        required
                      >
                        <TextInput
                          id="slack-bot-handle"
                          value={draft.slackBotHandle}
                          onChange={event =>
                            setDraft(current => ({
                              ...current,
                              slackBotHandle: event.target.value,
                            }))
                          }
                          placeholder="Your Slack App"
                          disabled={saving}
                          autoComplete="off"
                        />
                      </Field>
                      <ChannelCredentialsPanel
                        ccName={channelName.trim()}
                        pending={true}
                        presentation="inline"
                        onPendingChange={setPendingCredentials}
                        visibleChannelTypes={visibleChannelTypes}
                      />
                    </ProviderPanel>
                  )}

                  <CommunicationChannelAccessSelector
                    agentName={draft.hostRef}
                    disabled={saving}
                    inlineDropdowns
                    selectedTeamIds={draft.accessTeamIds}
                    selectedUserIds={draft.accessUserIds}
                    onSelectedTeamIdsChange={accessTeamIds =>
                      setDraft(current => ({ ...current, accessTeamIds }))
                    }
                    onSelectedUserIdsChange={accessUserIds =>
                      setDraft(current => ({ ...current, accessUserIds }))
                    }
                  />
                </div>
              )}

              {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

              <div className="cu-create-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => (step === 0 ? router.push('/communication-channels') : setStep(0))}
                  disabled={saving}
                >
                  {step === 0 ? 'Cancel' : 'Back'}
                </Button>
                <Button type="submit" variant="primary" size="sm" disabled={saving}>
                  {step === 0 ? 'Continue' : saving ? 'Creating...' : 'Create channel'}
                </Button>
              </div>
            </CreateStepFlow>
          </form>
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}

function ProviderPanel({
  checked,
  children,
  disabled,
  onCheckedChange,
  onReplyInThreadsChange,
  provider,
  replyInThreads,
  description,
}: {
  checked: boolean
  children: React.ReactNode
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
  onReplyInThreadsChange?: (checked: boolean) => void
  provider: ChannelProvider
  replyInThreads?: boolean
  description?: string
}) {
  return (
    <section className="cu-channel-provider-panel">
      <div className="cu-channel-provider-panel__head">
        <div>
          <p className="cu-section-title">
            {provider === 'slack' ? 'Slack app' : `${labelForProvider(provider)} bot`}
          </p>
          <p className="cu-muted">
            {description || 'Add credentials and default bot behavior for confirmed conversations.'}
          </p>
        </div>
      </div>
      <label className="cu-toggle-row">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={event => onCheckedChange(event.target.checked)}
        />
        <span>Answer only when the {provider === 'slack' ? 'app' : 'bot'} is mentioned</span>
      </label>
      {provider === 'slack' ? (
        <label className="cu-toggle-row">
          <input
            type="checkbox"
            checked={replyInThreads === true}
            disabled={disabled}
            onChange={event => onReplyInThreadsChange?.(event.target.checked)}
          />
          <span>
            Reply in threads{' '}
            <span
              className="cu-help-tooltip"
              tabIndex={0}
              aria-label="When enabled, app responses are posted in a Slack thread and follow-up messages in that thread continue there. New top-level messages start a new thread."
              data-tooltip="When enabled, app responses are posted in a Slack thread and follow-up messages in that thread continue there. New top-level messages start a new thread."
            >
              ?
            </span>
          </span>
        </label>
      ) : null}
      {children}
    </section>
  )
}
