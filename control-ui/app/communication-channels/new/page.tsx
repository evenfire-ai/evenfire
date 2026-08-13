'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { ChannelCredentialsPanel } from '@components/ChannelCredentialsPanel'
import type { CredentialDraft } from '@components/ChannelCredentialsPanel/types'
import { CommunicationChannelAccessSelector } from '@components/CommunicationChannelAccessSelector'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { SegmentedControl } from '@components/SegmentedControl'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconBroadcast } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconCopy } from '@components/icons'
import { Button, Field, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { SLACK_NEW_APP_URL } from '@constants/slack'
import { apiGet, apiSend } from '@lib/api'
import type { ChannelType } from '@lib/channelTypes'
import { copyTextToClipboard } from '@lib/clipboard'
import {
  COMMUNICATION_CHANNEL_PROVIDERS,
  COMMUNICATION_CHANNEL_PROVIDER_OPTIONS,
  type CommunicationChannelProvider,
  communicationChannelProviderServiceLabel,
} from '@lib/communicationChannelProviders'
import {
  type CommunicationChannelItem,
  slackWebhookUrlForChannelName,
  teamsWebhookPathForChannelName,
  teamsWebhookUrlForChannelName,
} from '@lib/communicationChannels'
import { canGenerateSlackAppManifest, slackAppManifest } from '@lib/slackAppManifest'
import { toKebabCase, toKebabInput } from '@lib/string'
import {
  LOCAL_TEAMS_ENDPOINT_ORIGIN,
  buildTeamsAppCreateCommand,
  canGenerateTeamsCommand,
} from '@lib/teamsSetup'

type HostItem = {
  metadata?: { name?: string }
}

type ChannelProvider = CommunicationChannelProvider

type DraftState = {
  accessTeamIds: string[]
  accessUserIds: string[]
  hostRef: string
  slackBotHandle: string
  slackReplyOnlyWhenMentioned: boolean
  slackReplyInThreads: boolean
  teamsAppName: string
  teamsAppId: string
  teamsTenantId: string
  teamsReplyOnlyWhenMentioned: boolean
  telegramBotHandle: string
  telegramReplyOnlyWhenMentioned: boolean
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEAMS_BOT_NAME_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/
const STEPS = ['Channel', 'Provider'] as const

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

function requiredCredentialKeysForProvider(type: ChannelProvider): Array<keyof CredentialDraft> {
  if (type === 'telegram') return ['telegram-bot-token']
  if (type === 'teams') return ['teams-app-password']
  return ['slack-signing-secret', 'slack-bot-token']
}

function credentialLabel(key: keyof CredentialDraft): string {
  switch (key) {
    case 'telegram-bot-token':
      return 'Telegram bot token'
    case 'slack-signing-secret':
      return 'Slack signing secret'
    case 'slack-bot-token':
      return 'Slack Bot User OAuth token'
    case 'teams-app-password':
      return 'CLIENT_SECRET'
    default:
      return String(key)
  }
}

function toTeamsBotNameInput(value: string): string {
  return toKebabInput(value).slice(0, 64)
}

function isValidTeamsBotName(value: string): boolean {
  return TEAMS_BOT_NAME_RE.test(value.trim())
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
  if (provider === 'slack') {
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
  return {
    telegram: [],
    slack: [],
    teams: [],
    teamsSettings: {
      appName: draft.teamsAppName.trim(),
      appId: draft.teamsAppId.trim(),
      tenantId: draft.teamsTenantId.trim(),
      replyOnlyWhenMentioned: draft.teamsReplyOnlyWhenMentioned,
    },
  }
}

function providerFromParam(value: string | null): ChannelProvider | null {
  return COMMUNICATION_CHANNEL_PROVIDERS.find(provider => provider === value) ?? null
}

function extractChannel(response: unknown, name: string): CommunicationChannelItem | null {
  if (!response || typeof response !== 'object') return null
  const direct = response as CommunicationChannelItem
  if (direct.metadata || direct.spec) return direct
  const wrapped = response as {
    channel?: CommunicationChannelItem
    item?: CommunicationChannelItem
  }
  if (wrapped.item) return wrapped.item
  if (wrapped.channel) return wrapped.channel
  const list = response as { items?: CommunicationChannelItem[] }
  return list.items?.find(item => item.metadata?.name === name) ?? null
}

export default function CreateCommunicationChannelPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const copyFrom = searchParams.get('copyFrom')?.trim() || ''
  const copyProvider = providerFromParam(searchParams.get('provider'))

  const [loadingHosts, setLoadingHosts] = useState(true)
  const [hosts, setHosts] = useState<HostItem[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState(0)
  const [canUseBrowserWebhookOrigin, setCanUseBrowserWebhookOrigin] = useState(false)

  const [channelName, setChannelName] = useState('')
  const [activeProvider, setActiveProvider] = useState<ChannelProvider>('telegram')
  const [draft, setDraft] = useState<DraftState>({
    accessTeamIds: [],
    accessUserIds: [],
    hostRef: '',
    slackBotHandle: '',
    slackReplyOnlyWhenMentioned: true,
    slackReplyInThreads: false,
    teamsAppName: '',
    teamsAppId: '',
    teamsTenantId: '',
    teamsReplyOnlyWhenMentioned: true,
    telegramBotHandle: '',
    telegramReplyOnlyWhenMentioned: true,
  })
  const [pendingCredentials, setPendingCredentials] = useState<CredentialDraft>({})
  const appliedCopyKeyRef = useRef<string | null>(null)

  const visibleChannelTypes = useMemo<ChannelType[]>(() => [activeProvider], [activeProvider])
  const normalizedChannelName = toKebabCase(channelName)
  const teamsWebhookUrl = useMemo(
    () =>
      normalizedChannelName
        ? canUseBrowserWebhookOrigin
          ? teamsWebhookUrlForChannelName(normalizedChannelName)
          : teamsWebhookPathForChannelName(normalizedChannelName)
        : null,
    [canUseBrowserWebhookOrigin, normalizedChannelName]
  )
  // A relative endpoint would register a Teams bot pointing at a host that does
  // not exist, so a deployment with no public webhook origin warns instead of
  // handing over a command built from a placeholder.
  const teamsAppCreateCommand = useMemo(() => {
    if (!teamsWebhookUrl || !canGenerateTeamsCommand(teamsWebhookUrl)) return null
    return buildTeamsAppCreateCommand({ botName: draft.teamsAppName, endpoint: teamsWebhookUrl })
  }, [draft.teamsAppName, teamsWebhookUrl])
  // Slack's order is manifest first, credentials second: the bot token only exists
  // after the app is installed, so a manifest offered only once the channel is saved
  // arrives after the step it describes. The Request URL encodes namespace and name
  // only, so it is derivable here — from the NORMALIZED name, which is what the save
  // will persist. Deriving it from the raw input would hand over a URL for a channel
  // that never exists, which is the failure this manifest was written to remove.
  const slackRequestUrl = useMemo(
    () =>
      normalizedChannelName && canUseBrowserWebhookOrigin
        ? slackWebhookUrlForChannelName(normalizedChannelName)
        : null,
    [canUseBrowserWebhookOrigin, normalizedChannelName]
  )
  // No app name, no manifest: the name becomes display_information.name, and a
  // placeholder would install an app under a name the operator never chose.
  const slackManifest = useMemo(() => {
    const appName = draft.slackBotHandle.trim()
    if (!appName || !slackRequestUrl || !canGenerateSlackAppManifest(slackRequestUrl)) return null
    return slackAppManifest(appName, slackRequestUrl)
  }, [draft.slackBotHandle, slackRequestUrl])
  const teamsBotNameIsValid = isValidTeamsBotName(draft.teamsAppName)

  useEffect(() => {
    setCanUseBrowserWebhookOrigin(true)
  }, [])

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

  useEffect(() => {
    if (!copyFrom || !copyProvider) return
    const copyKey = `${copyFrom}:${copyProvider}`
    if (appliedCopyKeyRef.current === copyKey) return
    appliedCopyKeyRef.current = copyKey

    async function loadCopySource() {
      setError('')
      try {
        const response = await apiGet(
          `/api/v1/admin/communication-channels/${encodeURIComponent(copyFrom)}`
        ).catch(async error => {
          if (error instanceof Error && error.message.includes('404')) {
            return apiGet('/api/v1/admin/communication-channels')
          }
          throw error
        })
        const source = extractChannel(response, copyFrom)
        if (!source) {
          setError(`Communication channel ${copyFrom} was not found.`)
          return
        }
        const spec = source.spec || {}
        setChannelName('')
        setStep(0)
        setActiveProvider(copyProvider)
        setPendingCredentials({})
        setDraft(current => ({
          ...current,
          accessTeamIds: spec.access?.teams || [],
          accessUserIds: spec.access?.users || [],
          hostRef: spec.hostRef || '',
        }))
      } catch (copyError) {
        setError(
          copyError instanceof Error
            ? copyError.message
            : 'Failed to load communication channel copy source'
        )
      }
    }

    void loadCopySource()
  }, [copyFrom, copyProvider])

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

  async function copyTeamsAppCreateCommand() {
    if (!teamsAppCreateCommand) return
    const copied = await copyTextToClipboard(teamsAppCreateCommand)
    showToast(
      copied
        ? 'Teams bot command copied.'
        : 'Could not copy to clipboard. Select the command and copy it manually.',
      { tone: copied ? 'success' : 'error' }
    )
  }

  async function copySlackAppManifest() {
    if (!slackManifest) return
    const copied = await copyTextToClipboard(slackManifest)
    showToast(
      copied
        ? 'Slack app manifest copied.'
        : 'Could not copy to clipboard. Select the manifest and copy it manually.',
      { tone: copied ? 'success' : 'error' }
    )
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
    if (activeProvider === 'teams') {
      if (!isValidTeamsBotName(draft.teamsAppName)) {
        setError('Name must start with a letter and use lowercase letters, numbers, and hyphens.')
        return
      }
      if (!UUID_RE.test(draft.teamsAppId.trim())) {
        setError('CLIENT_ID must be a valid UUID.')
        return
      }
      if (!UUID_RE.test(draft.teamsTenantId.trim())) {
        setError('TENANT_ID must be a valid UUID.')
        return
      }
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
      router.push(CONTROL_ROUTES.externalChannels.root)
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
              onBack={() => router.push(CONTROL_ROUTES.externalChannels.root)}
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
                  <SegmentedControl<ChannelProvider>
                    ariaLabel="Communication channel provider"
                    value={activeProvider}
                    className="cu-segmented-control--flush cu-segmented-control--full"
                    disabled={saving}
                    onChange={handleProviderChange}
                    options={COMMUNICATION_CHANNEL_PROVIDER_OPTIONS}
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
                  ) : activeProvider === 'slack' ? (
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
                      {slackManifest ? (
                        <div className="cu-field">
                          <span className="cu-field__label">Slack App Manifest</span>
                          <div className="cu-command-block">
                            <div className="cu-command-block__toolbar">
                              <span>YAML</span>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="cu-command-block__copy"
                                onClick={copySlackAppManifest}
                                disabled={saving}
                                aria-label="Copy Slack app manifest"
                              >
                                <IconCopy width={15} height={15} />
                                Copy
                              </Button>
                            </div>
                            <pre className="cu-command-block__pre cu-slack-manifest__pre">
                              <code>{slackManifest}</code>
                            </pre>
                          </div>
                          <span className="cu-field__hint">
                            Copy this, then{' '}
                            <a
                              className="cu-link"
                              href={SLACK_NEW_APP_URL}
                              target="_blank"
                              rel="noreferrer"
                            >
                              create your Slack app
                            </a>{' '}
                            — choose <strong>From an app manifest</strong>, pick the workspace, and
                            paste. It sets the scopes, the events, and both Request URLs, so the app
                            is ready before you come back here for the token below. Opens in a new
                            tab so this form keeps what you have typed.
                          </span>
                          <span className="cu-field__hint">
                            The Request URLs point at <code>{normalizedChannelName}</code>, so this
                            channel has to be created under that name.
                          </span>
                        </div>
                      ) : draft.slackBotHandle.trim() && normalizedChannelName ? (
                        // Named and ready, but no absolute URL resolved: a manifest with a
                        // relative request_url is invalid to Slack. Say so rather than render
                        // nothing -- the operator is following a guide that promises a manifest
                        // here, and silence gives them no cause to chase.
                        <div className="cu-banner cu-banner--warning">
                          No app manifest: this deployment has no public webhook address, so the
                          Request URL would be a path Slack cannot reach. Expose the webhook proxy
                          publicly and set NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL to that
                          address, then reload this page.
                        </div>
                      ) : null}
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
                      provider="teams"
                      description="Use a Microsoft Teams bot for one tenant. Add the bot details and client secret, then users can verify conversations from Teams."
                      checked={draft.teamsReplyOnlyWhenMentioned}
                      disabled={saving}
                      onCheckedChange={checked =>
                        setDraft(current => ({
                          ...current,
                          teamsReplyOnlyWhenMentioned: checked,
                        }))
                      }
                    >
                      <section className="cu-teams-setup">
                        <div>
                          <p className="cu-section-title">Create the Teams bot</p>
                          <p className="cu-muted">
                            Run the Teams CLI command, then copy the generated bot values into this
                            channel.
                          </p>
                        </div>
                        <Field
                          description="Use lowercase letters, numbers, and hyphens. The name must start with a letter."
                          htmlFor="teams-app-name"
                          label="Name"
                          required
                        >
                          <TextInput
                            id="teams-app-name"
                            value={draft.teamsAppName}
                            onChange={event =>
                              setDraft(current => ({
                                ...current,
                                teamsAppName: toTeamsBotNameInput(event.target.value),
                              }))
                            }
                            placeholder="evenfire-bot"
                            disabled={saving}
                            autoComplete="off"
                            invalid={Boolean(draft.teamsAppName) && !teamsBotNameIsValid}
                          />
                        </Field>
                        <ol className="cu-teams-setup__instructions">
                          <li>
                            Run this from the project directory that has the Teams CLI project.
                          </li>
                          <li>
                            The command writes generated Teams bot values into <code>.env</code>.
                          </li>
                          <li>
                            In Teams Developer Portal, enable{' '}
                            <strong>Upload and download files</strong> for the Bot feature.
                          </li>
                          <li>Paste CLIENT_ID, TENANT_ID, and CLIENT_SECRET below.</li>
                        </ol>
                        {teamsAppCreateCommand ? (
                          <div className="cu-command-block">
                            <div className="cu-command-block__toolbar">
                              <span>Bash</span>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="cu-command-block__copy"
                                onClick={copyTeamsAppCreateCommand}
                                disabled={saving || !teamsBotNameIsValid}
                                aria-label="Copy Teams bot create command"
                              >
                                <IconCopy width={15} height={15} />
                                Copy
                              </Button>
                            </div>
                            <pre className="cu-command-block__pre">
                              <code>{teamsAppCreateCommand}</code>
                            </pre>
                          </div>
                        ) : (
                          <div className="cu-banner cu-banner--warning">
                            This deployment has no public webhook origin, so the command below
                            cannot be generated. Set{' '}
                            <code>NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL</code>, or
                            substitute your own public origin for{' '}
                            <code>{LOCAL_TEAMS_ENDPOINT_ORIGIN}</code> before running it.
                          </div>
                        )}
                      </section>
                      <Field
                        description="CLIENT_ID from the generated .env file."
                        htmlFor="teams-app-id"
                        label="CLIENT_ID"
                        required
                      >
                        <TextInput
                          id="teams-app-id"
                          value={draft.teamsAppId}
                          onChange={event =>
                            setDraft(current => ({
                              ...current,
                              teamsAppId: event.target.value,
                            }))
                          }
                          placeholder="00000000-0000-0000-0000-000000000000"
                          disabled={saving}
                          autoComplete="off"
                        />
                      </Field>
                      <Field
                        description="TENANT_ID from the generated .env file."
                        htmlFor="teams-tenant-id"
                        label="TENANT_ID"
                        required
                      >
                        <TextInput
                          id="teams-tenant-id"
                          value={draft.teamsTenantId}
                          onChange={event =>
                            setDraft(current => ({
                              ...current,
                              teamsTenantId: event.target.value,
                            }))
                          }
                          placeholder="00000000-0000-0000-0000-000000000000"
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
                  onClick={() =>
                    step === 0 ? router.push(CONTROL_ROUTES.externalChannels.root) : setStep(0)
                  }
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
          <p className="cu-section-title">{communicationChannelProviderServiceLabel(provider)}</p>
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
