'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { ChannelCredentialsPanel } from '@components/ChannelCredentialsPanel'
import type { CredentialDraft } from '@components/ChannelCredentialsPanel/types'
import { CommunicationChannelAccessSelector } from '@components/CommunicationChannelAccessSelector'
import { CommunicationChannelIdentity } from '@components/CommunicationChannelIdentity'
import { CommunicationChannelProviderSetup } from '@components/CommunicationChannelProviderSetup'
import type { ProviderDraft } from '@components/CommunicationChannelProviderSetup/types'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconBroadcast } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { Button } from '@components/ui'
import { CHANNEL_STEP_DETAILS, CHANNEL_STEP_LABELS } from '@constants/communicationChannelFlow'
import { CONTROL_ROUTES } from '@constants/routes'
import { apiGet, apiSend } from '@lib/api'
import type { ChannelType } from '@lib/channelTypes'
import {
  COMMUNICATION_CHANNEL_PROVIDERS,
  type CommunicationChannelProvider,
} from '@lib/communicationChannelProviders'
import type { CommunicationChannelItem } from '@lib/communicationChannels'
import { toKebabCase } from '@lib/string'
import { teamsAppNameError } from '@lib/teamsSetup'

type HostItem = {
  metadata?: { name?: string }
}

type ChannelProvider = CommunicationChannelProvider

type DraftState = ProviderDraft & {
  accessTeamIds: string[]
  accessUserIds: string[]
  hostRef: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

/**
 * Spec fields for the selected provider, and only that provider.
 *
 * This deliberately does not emit empty arrays for the providers that were not
 * selected. channel-reader guards its polling branches on the presence of the
 * provider array, and `[]` is truthy, so a Teams channel carrying `telegram: []`
 * entered the telegram branch, found no telegram adapter, and skipped every
 * remaining provider on that channel. Sending only the chosen provider keeps a
 * channel's spec an honest description of what it is.
 *
 * This is the create payload, so there is nothing to clear: a POST builds a
 * fresh spec, and control-api validates each array only when it is present
 * (`if (Array.isArray(...))`). An edit flow that has to unset a previously
 * configured provider needs its own explicit empty array and must not rely on
 * this helper.
 */
function providerSettings(provider: ChannelProvider, draft: DraftState) {
  if (provider === 'telegram') {
    return {
      telegram: [],
      telegramSettings: {
        botHandle: draft.telegramBotHandle.trim(),
        replyOnlyWhenMentioned: draft.telegramReplyOnlyWhenMentioned,
      },
    }
  }
  if (provider === 'slack') {
    return {
      slack: [],
      slackSettings: {
        botHandle: draft.slackBotHandle.trim(),
        replyOnlyWhenMentioned: draft.slackReplyOnlyWhenMentioned,
        replyInThreads: draft.slackReplyInThreads,
      },
    }
  }
  return {
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

  const [channelName, setChannelName] = useState('')
  const [activeProvider, setActiveProvider] = useState<ChannelProvider>(
    () => copyProvider || 'telegram'
  )
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
  const teamsBotNameError = teamsAppNameError(draft.teamsAppName)

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
      setError('Agent is required.')
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
    if (step === 1) {
      if (validateProviderStep()) {
        setError('')
        setStep(2)
      }
      return
    }
    await handleCreateChannel()
  }

  function validateProviderStep() {
    for (const credentialKey of requiredCredentialKeysForProvider(activeProvider)) {
      const selectedValue = (pendingCredentials[credentialKey] || '').trim()
      if (!selectedValue) {
        setError(`${credentialLabel(credentialKey)} is required.`)
        return false
      }
    }
    if (
      activeProvider === 'telegram' &&
      !/^@?[A-Za-z0-9_]{5,32}$/.test(draft.telegramBotHandle.trim())
    ) {
      setError('A valid Telegram bot handle is required.')
      return false
    }
    if (activeProvider === 'slack' && !draft.slackBotHandle.trim()) {
      setError('Slack App Name is required.')
      return false
    }
    if (activeProvider === 'teams') {
      if (teamsBotNameError) {
        setError(teamsBotNameError)
        return false
      }
      if (!UUID_RE.test(draft.teamsAppId.trim())) {
        setError('CLIENT_ID must be a valid UUID.')
        return false
      }
      if (!UUID_RE.test(draft.teamsTenantId.trim())) {
        setError('TENANT_ID must be a valid UUID.')
        return false
      }
    }

    return true
  }

  async function handleCreateChannel() {
    if (!validateIdentityStep()) {
      setStep(0)
      return
    }
    if (!validateProviderStep()) {
      setStep(1)
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
              onStepChange={next => {
                if (saving) return
                if (next > 0 && !validateIdentityStep()) return
                if (next > 1 && !validateProviderStep()) return
                setError('')
                setStep(next)
              }}
              steps={CHANNEL_STEP_DETAILS}
              stepLabels={CHANNEL_STEP_LABELS}
              titleId="create-channel-title"
            >
              <div hidden={step !== 0}>
                <CommunicationChannelIdentity
                  channelName={channelName}
                  onNameChange={setChannelName}
                  agentName={draft.hostRef}
                  onAgentChange={updateHostRef}
                  agentOptions={hosts
                    .map(host => host.metadata?.name || '')
                    .filter(Boolean)
                    .map(value => ({ value, label: value }))}
                  loadingAgents={loadingHosts}
                  disabled={saving}
                />
              </div>
              <div hidden={step !== 1}>
                <div className="cu-form-stack cu-agent-form-stack--wide">
                  <CommunicationChannelProviderSetup
                    channelName={channelName}
                    activeProvider={activeProvider}
                    draft={draft}
                    onChange={next => setDraft(current => ({ ...current, ...next }))}
                    onProviderChange={handleProviderChange}
                    saving={saving}
                    credentials={
                      <ChannelCredentialsPanel
                        ccName={channelName.trim()}
                        pending
                        presentation="inline"
                        requiredKeys={requiredCredentialKeysForProvider(activeProvider)}
                        onPendingChange={setPendingCredentials}
                        visibleChannelTypes={visibleChannelTypes}
                      />
                    }
                  />
                </div>
              </div>
              {step === 2 ? (
                <CommunicationChannelAccessSelector
                  showHeader={false}
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
              ) : null}

              {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

              <div className="cu-create-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (step === 0) router.push(CONTROL_ROUTES.externalChannels.root)
                    else {
                      setError('')
                      setStep(step - 1)
                    }
                  }}
                  disabled={saving}
                >
                  {step === 0 ? 'Cancel' : 'Back'}
                </Button>
                <Button type="submit" variant="primary" size="sm" disabled={saving}>
                  {step < 2 ? 'Continue' : saving ? 'Creating...' : 'Create channel'}
                </Button>
              </div>
            </CreateStepFlow>
          </form>
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
