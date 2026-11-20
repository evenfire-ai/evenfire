'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { FormSectionsSkeleton } from '@components/BodyLoadingSkeleton'
import { ChannelCredentialsPanel } from '@components/ChannelCredentialsPanel'
import type { CredentialEditStates, CredentialKey } from '@components/ChannelCredentialsPanel/types'
import { CommunicationChannelAccessSelector } from '@components/CommunicationChannelAccessSelector'
import { CommunicationChannelConversationsTable } from '@components/CommunicationChannelConversations'
import type { CommunicationChannelConversation } from '@components/CommunicationChannelConversations/types'
import { CommunicationChannelIdentity } from '@components/CommunicationChannelIdentity'
import { CommunicationChannelProviderSetup } from '@components/CommunicationChannelProviderSetup'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconBroadcast } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { CHANNEL_STEP_DETAILS, CHANNEL_STEP_LABELS } from '@constants/communicationChannelFlow'
import { CONTROL_ROUTES } from '@constants/routes'
import { apiGet, apiSend, isSilentApiError } from '@lib/api'
import {
  buildCredentialOperationPlan,
  cleanCredentialStates,
  credentialStateIsDirty,
} from '@lib/channelCredentialSave'
import type { ChannelType } from '@lib/channelTypes'
import {
  type CommunicationChannelDraftState,
  buildCommunicationChannelSpec,
  communicationChannelInitialTab,
  createCommunicationChannelDraft,
  hasSlackConfigForRequestUrl,
  hasTeamsConfigForRequestUrl,
} from '@lib/communicationChannelEdit'
import { type CommunicationChannelProvider } from '@lib/communicationChannelProviders'
import {
  type CommunicationChannelItem,
  slackWebhookUrlForChannelName,
  teamsWebhookUrlForChannelName,
} from '@lib/communicationChannels'
import { teamsAppNameError } from '@lib/teamsSetup'

type ChannelProvider = CommunicationChannelProvider
type DraftState = CommunicationChannelDraftState

type HostItem = {
  metadata?: { name?: string; namespace?: string }
}

type HostsResponse = {
  hosts?: HostItem[]
  items?: HostItem[]
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

/** Detail shown under the panel's read-failed banner when the request itself
 *  succeeded but the body did not carry a usable key list. */
const CREDENTIALS_SHAPE_ERROR = 'The credentials response did not list the stored keys.'
/** Same, when the request threw something that is not an Error. */
const CREDENTIALS_REQUEST_ERROR = 'The credentials request failed.'

/**
 * Key names from `GET .../credentials`, or `undefined` when the answer is not
 * usable. Undefined is never "nothing stored": callers turn it into the panel's
 * read-failed state, which says so and offers a retry.
 */
function extractCredentialKeys(response: unknown): string[] | undefined {
  if (!response || typeof response !== 'object') return undefined
  const keys = (response as { keys?: unknown }).keys
  if (!Array.isArray(keys)) return undefined
  return keys.filter((key): key is string => typeof key === 'string')
}

function conversationsForProvider(
  provider: ChannelProvider,
  draft: DraftState
): CommunicationChannelConversation[] {
  const conversations =
    provider === 'telegram' ? draft.telegram : provider === 'slack' ? draft.slack : draft.teams
  return conversations.map(group => ({
    ...group,
    provider,
  }))
}

export default function EditCommunicationChannelPage() {
  const router = useRouter()
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(params?.name ?? '')
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()

  const [item, setItem] = useState<CommunicationChannelItem | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [savedDraft, setSavedDraft] = useState<DraftState | null>(null)
  const [credentialEditStates, setCredentialEditStates] = useState<CredentialEditStates>({})
  const [step, setStep] = useState(0)
  const [activeTab, setActiveTab] = useState<ChannelProvider>('telegram')
  const [hosts, setHosts] = useState<HostItem[]>([])
  // Which credential keys the channel's Secret actually holds. Undefined until
  // the read lands, so the panel renders pending instead of "nothing stored".
  const [storedCredentialKeys, setStoredCredentialKeys] = useState<string[] | undefined>(undefined)
  // Why that read failed, when it did. Undefined keys ALONE cannot say whether
  // the read is still running or is over and broken, and the panel disables
  // itself while it believes a read is in flight — so swallowing the error left
  // every credential control dead until a page reload, with no way to tell.
  const [credentialKeysError, setCredentialKeysError] = useState('')
  // Drops a stale credentials response when the read is retried or `name` changes.
  const credentialsRequestId = useRef(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveRefreshPending, setSaveRefreshPending] = useState(false)

  function backToChannels() {
    router.push(CONTROL_ROUTES.externalChannels.root)
  }

  // Key names only — the API never returns values. A failure here must not take
  // the whole page down, must not be read as "no credentials", and must not be
  // read as "still loading" either: it is its own state, with a retry.
  const loadCredentialKeys = useCallback(async (channelName: string) => {
    if (!channelName) return
    const id = ++credentialsRequestId.current
    setStoredCredentialKeys(undefined)
    setCredentialKeysError('')
    try {
      const response = await apiGet(
        `/api/v1/admin/communication-channels/${encodeURIComponent(channelName)}/credentials`
      )
      if (id !== credentialsRequestId.current) return
      const keys = extractCredentialKeys(response)
      if (!keys) {
        setCredentialKeysError(CREDENTIALS_SHAPE_ERROR)
        return
      }
      setStoredCredentialKeys(keys)
      return keys
    } catch (error) {
      // A silent error is an expired session: the app is already redirecting,
      // so a banner about credentials would just be noise on the way out.
      if (id !== credentialsRequestId.current || isSilentApiError(error)) return
      setCredentialKeysError(error instanceof Error ? error.message : CREDENTIALS_REQUEST_ERROR)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const [channelResponse, hostsResponse] = await Promise.all([
          apiGet(`/api/v1/admin/communication-channels/${encodeURIComponent(name)}`).catch(
            async error => {
              if (isSilentApiError(error)) return null
              return apiGet('/api/v1/admin/communication-channels')
            }
          ),
          apiGet('/api/v1/admin/hosts') as Promise<HostsResponse | HostItem[]>,
          // Runs alongside the other two, but owns its own state: a credentials
          // failure is reported in the panel, not by failing the page load.
          loadCredentialKeys(name),
        ])
        if (cancelled || channelResponse === null) return
        const nextItem = extractChannel(channelResponse, name)
        if (!nextItem) {
          setLoadError(`Communication channel ${name} was not found.`)
          return
        }
        const nextHosts = Array.isArray(hostsResponse)
          ? hostsResponse
          : hostsResponse.items || hostsResponse.hosts || []
        setItem(nextItem)
        const nextDraft = createCommunicationChannelDraft(nextItem)
        setDraft(nextDraft)
        setSavedDraft(nextDraft)
        setCredentialEditStates({})
        setSaveRefreshPending(false)
        setActiveTab(communicationChannelInitialTab(nextItem))
        setHosts(nextHosts)
      } catch (error) {
        if (isSilentApiError(error)) return
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : 'Failed to load communication channel'
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (name) void load()
    return () => {
      cancelled = true
    }
  }, [name, loadCredentialKeys])

  const visibleChannelTypes = useMemo<ChannelType[]>(() => [activeTab], [activeTab])
  const validCredentialChannelTypes = useMemo<ChannelType[]>(() => {
    if (!draft) return []
    const spec = buildCommunicationChannelSpec(draft)
    return [
      ...(spec.telegram || spec.telegramSettings ? (['telegram'] as const) : []),
      ...(spec.slack || spec.slackSettings ? (['slack'] as const) : []),
      ...(spec.teams || spec.teamsSettings ? (['teams'] as const) : []),
      ...(spec.email ? (['email'] as const) : []),
    ]
  }, [draft])
  const specDirty = useMemo(
    () =>
      Boolean(
        draft &&
        savedDraft &&
        JSON.stringify(buildCommunicationChannelSpec(draft)) !==
          JSON.stringify(buildCommunicationChannelSpec(savedDraft))
      ),
    [draft, savedDraft]
  )
  const credentialsDirty = Object.values(credentialEditStates).some(credentialStateIsDirty)
  const formDirty = specDirty || credentialsDirty || saveRefreshPending
  const activeConversations = draft ? conversationsForProvider(activeTab, draft) : []
  // Gated on the DRAFT, not the persisted item. Slack's own order is manifest
  // first, credentials second: the bot token only exists after the app has been
  // created and installed, so a manifest that needed a saved Slack spec could
  // only ever appear after the operator had already done the step it describes.
  // The URL depends only on namespace/name, both fixed at create time, and the
  // reader resolves that id regardless of slackSettings, so a draft-derived URL
  // is already server-truthful. The guard against a copyable dead end on a
  // non-Slack channel is kept: no Slack config in the draft, no URL. A bot
  // handle the draft only inherited from the clerum.io/slack-bot-label
  // annotation is not Slack config, which is why this is not hasSlackConfig.
  const slackRequestUrl =
    draft && hasSlackConfigForRequestUrl(draft)
      ? slackWebhookUrlForChannelName(
          item?.metadata?.name?.trim() || name,
          item?.metadata?.namespace
        )
      : null
  // Gated on the DRAFT, not the persisted item, for the same reason as Slack
  // above: the Teams bot credentials only exist after `teams app create` has
  // run, and that command needs this URL. A URL that required a saved
  // teamsSettings could only appear after the operator had already done the
  // step it describes. The URL depends only on namespace/name, both fixed at
  // create time, and the reader resolves that id regardless of teamsSettings.
  const teamsRequestUrl =
    draft && hasTeamsConfigForRequestUrl(draft)
      ? teamsWebhookUrlForChannelName(
          item?.metadata?.name?.trim() || name,
          item?.metadata?.namespace
        )
      : null

  /**
   * The single validation boundary for this page: every path that persists a
   * full spec goes through here, Save and deleteConversation alike. Validating
   * in handleSave instead let deleteConversation persist a value Save refuses.
   *
   * It validates the SPEC, not the draft, because the spec is what is sent: an
   * empty name is omitted by buildCommunicationChannelSpec rather than written
   * as an empty string, which is exactly what the server accepts.
   *
   * Returns false when nothing was persisted, so callers do not navigate away
   * from an unsaved page -- neither on a rejected value nor on a failed PUT.
   */
  async function persistDraft(nextDraft: DraftState, successMessage: string): Promise<boolean> {
    const spec = buildCommunicationChannelSpec(nextDraft)
    const teamsAppName = spec.teamsSettings?.appName
    const nameError = teamsAppName === undefined ? null : teamsAppNameError(teamsAppName)
    if (nameError) {
      setSaveError(nameError)
      return false
    }
    setSaving(true)
    setSaveError('')
    try {
      await apiSend('PUT', `/api/v1/admin/communication-channels/${encodeURIComponent(name)}`, {
        spec,
      })
      setDraft(nextDraft)
      setSavedDraft(nextDraft)
      showToast(successMessage, { tone: 'success' })
      return true
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save communication channel')
      return false
    } finally {
      setSaving(false)
    }
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft || saving) return
    const spec = buildCommunicationChannelSpec(draft)
    const teamsName = spec.teamsSettings?.appName
    const nameError = teamsName === undefined ? null : teamsAppNameError(teamsName)
    const plan = buildCredentialOperationPlan(credentialEditStates, validCredentialChannelTypes)
    if (nameError || plan.invalidLabels.length) {
      setSaveError(
        nameError || `Credential changes are no longer valid for: ${plan.invalidLabels.join(', ')}.`
      )
      return
    }
    if (!specDirty && plan.operations.length === 0 && !saveRefreshPending) return

    setSaving(true)
    setSaveError('')
    let mutationCommitted = saveRefreshPending
    let channelSettingsSaved = false
    const failedLabels: string[] = []
    try {
      if (specDirty) {
        await apiSend('PUT', `/api/v1/admin/communication-channels/${encodeURIComponent(name)}`, {
          spec,
        })
        mutationCommitted = true
        channelSettingsSaved = true
        setSavedDraft(draft)
        setSaveRefreshPending(true)
      }

      const channelResponse = await apiGet(
        `/api/v1/admin/communication-channels/${encodeURIComponent(name)}`
      )
      const authoritativeItem = extractChannel(channelResponse, name)
      if (!authoritativeItem) throw new Error(`Communication channel ${name} was not found.`)
      const authoritativeDraft = createCommunicationChannelDraft(authoritativeItem)
      const authoritativeSpec = buildCommunicationChannelSpec(authoritativeDraft)
      const authoritativeTypes: ChannelType[] = [
        ...(authoritativeSpec.telegram || authoritativeSpec.telegramSettings
          ? (['telegram'] as const)
          : []),
        ...(authoritativeSpec.slack || authoritativeSpec.slackSettings ? (['slack'] as const) : []),
        ...(authoritativeSpec.teams || authoritativeSpec.teamsSettings ? (['teams'] as const) : []),
        ...(authoritativeSpec.email ? (['email'] as const) : []),
      ]
      const validatedPlan = buildCredentialOperationPlan(credentialEditStates, authoritativeTypes)
      if (validatedPlan.invalidLabels.length) {
        setItem(authoritativeItem)
        setDraft(authoritativeDraft)
        setSavedDraft(authoritativeDraft)
        setSaveError(
          `${channelSettingsSaved ? 'Channel settings were saved, but ' : ''}credential changes are no longer valid for: ${validatedPlan.invalidLabels.join(', ')}.`
        )
        return
      }

      const successful: CredentialKey[] = []
      for (const operation of validatedPlan.operations) {
        try {
          if (operation.kind === 'replace') {
            await apiSend(
              'PUT',
              `/api/v1/admin/communication-channels/${encodeURIComponent(name)}/credentials`,
              { [operation.key]: operation.value }
            )
          } else {
            await apiSend(
              'DELETE',
              `/api/v1/admin/communication-channels/${encodeURIComponent(name)}/credentials/${encodeURIComponent(operation.key)}`
            )
          }
          successful.push(operation.key)
          mutationCommitted = true
        } catch {
          failedLabels.push(operation.label)
        }
      }

      if (successful.length) {
        setCredentialEditStates(current => cleanCredentialStates(current, successful))
        setSaveRefreshPending(true)
      }

      const [refreshedChannel, refreshedKeys] = await Promise.all([
        apiGet(`/api/v1/admin/communication-channels/${encodeURIComponent(name)}`),
        loadCredentialKeys(name),
      ])
      if (!refreshedKeys) {
        throw new Error('Could not refresh authoritative credential presence after saving.')
      }
      const refreshedItem = extractChannel(refreshedChannel, name) ?? authoritativeItem
      const refreshedDraft = createCommunicationChannelDraft(refreshedItem)
      setItem(refreshedItem)
      setDraft(refreshedDraft)
      setSavedDraft(refreshedDraft)
      setSaveRefreshPending(false)

      if (failedLabels.length) {
        setSaveError(
          `${channelSettingsSaved ? 'Channel settings were saved, but ' : ''}some credential changes failed: ${failedLabels.join(', ')}. Retry Save to apply the remaining changes.`
        )
        return
      }
      setCredentialEditStates({})
      showToast(`Communication channel ${name} updated.`, { tone: 'success' })
      backToChannels()
    } catch (error) {
      if (failedLabels.length) {
        const refreshError = error instanceof Error ? error.message : 'refresh failed'
        setSaveError(
          `${channelSettingsSaved ? 'Channel settings were saved, but ' : ''}credential changes failed for: ${failedLabels.join(', ')}. The authoritative refresh also failed: ${refreshError}. Retry Save to apply remaining changes and refresh.`
        )
      } else if (mutationCommitted) {
        setSaveRefreshPending(true)
        setSaveError(
          'Channel settings were saved, but the authoritative refresh failed. Retry Save to refresh without resending successful credential changes.'
        )
      } else {
        setSaveError(
          error instanceof Error ? error.message : 'Failed to save communication channel'
        )
      }
    } finally {
      setSaving(false)
    }
  }

  async function deleteConversation(conversation: CommunicationChannelConversation) {
    if (!draft || saving) return
    const shouldDelete = await confirm({
      title: 'Delete Conversation',
      message: 'Delete this confirmed conversation from the communication channel?',
      confirmLabel: 'Delete conversation',
      tone: 'danger',
    })
    if (!shouldDelete) return
    const nextDraft =
      conversation.provider === 'telegram'
        ? {
            ...draft,
            telegram: draft.telegram.filter(group => group.channelId !== conversation.channelId),
          }
        : conversation.provider === 'slack'
          ? {
              ...draft,
              slack: draft.slack.filter(group => group.channelId !== conversation.channelId),
            }
          : {
              ...draft,
              teams: draft.teams.filter(group => group.channelId !== conversation.channelId),
            }
    await persistDraft(nextDraft, 'Conversation deleted.')
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconBroadcast />}
              title={`Edit Communication Channel: ${name}`}
              subtitle="Update agent access, provider settings, and write-only credentials."
              backLabel="Back to channels"
              onBack={backToChannels}
            />
          }
        >
          {loading ? (
            <FormSectionsSkeleton
              className="cu-channel-edit-form"
              label="Communication channel"
              primaryActionLabel="Save channel"
              sections={3}
            />
          ) : loadError ? (
            <div className="cu-create-content cu-channel-edit-form">
              <div className="cu-banner cu-banner--error" role="alert">
                {loadError}
              </div>
            </div>
          ) : item && draft ? (
            <form className="cu-channel-create-panel" onSubmit={handleSave}>
              <CreateStepFlow
                ariaLabel="Channel details steps"
                currentStep={step}
                onStepChange={setStep}
                canSelectStep={() => !saving}
                steps={CHANNEL_STEP_DETAILS}
                stepLabels={CHANNEL_STEP_LABELS}
                titleId="edit-channel-title"
              >
                <div hidden={step !== 0}>
                  <CommunicationChannelIdentity
                    channelName={item.metadata?.name || name}
                    agentName={draft.hostRef}
                    onAgentChange={hostRef =>
                      setDraft(current =>
                        current
                          ? {
                              ...current,
                              hostRef,
                              accessTeamIds:
                                current.hostRef === hostRef ? current.accessTeamIds : [],
                              accessUserIds:
                                current.hostRef === hostRef ? current.accessUserIds : [],
                            }
                          : current
                      )
                    }
                    agentOptions={hosts.map(host => ({
                      value: host.metadata?.name || '',
                      label: host.metadata?.name || '-',
                    }))}
                    disabled={saving}
                  />
                </div>
                <div hidden={step !== 1}>
                  <CommunicationChannelProviderSetup
                    channelName={item.metadata?.name || name}
                    activeProvider={activeTab}
                    draft={draft}
                    onChange={(next, field) =>
                      setDraft(current =>
                        current
                          ? {
                              ...current,
                              ...next,
                              slackBotHandleFromAnnotation:
                                field === 'slackBotHandle'
                                  ? false
                                  : current.slackBotHandleFromAnnotation,
                              teamsAppNameFromAnnotation:
                                field === 'teamsAppName'
                                  ? false
                                  : current.teamsAppNameFromAnnotation,
                            }
                          : current
                      )
                    }
                    onProviderChange={setActiveTab}
                    saving={saving}
                    slackRequestUrlOverride={slackRequestUrl}
                    teamsRequestUrlOverride={teamsRequestUrl}
                    showRequestUrls
                    credentials={
                      <ChannelCredentialsPanel
                        ccName={item.metadata?.name || name}
                        presentation="inline"
                        visibleChannelTypes={visibleChannelTypes}
                        storedKeys={storedCredentialKeys}
                        storedKeysError={credentialKeysError}
                        onRetryStoredKeys={() => void loadCredentialKeys(name)}
                        editStates={credentialEditStates}
                        onEditStateChange={(key, state) =>
                          setCredentialEditStates(current => ({ ...current, [key]: state }))
                        }
                        saving={saving}
                      />
                    }
                  />

                  <section className="cu-channel-provider-panel">
                    <div className="cu-channel-provider-panel__head">
                      <div>
                        <p className="cu-section-title">Confirmed conversations</p>
                        <p className="cu-muted">
                          Conversations are connected from Profile UI and can be removed here.
                        </p>
                      </div>
                    </div>
                    <CommunicationChannelConversationsTable
                      conversations={activeConversations}
                      onDelete={deleteConversation}
                    />
                  </section>
                </div>
                <div hidden={step !== 2}>
                  <CommunicationChannelAccessSelector
                    showHeader={false}
                    agentName={draft.hostRef}
                    disabled={saving}
                    inlineDropdowns
                    selectedTeamIds={draft.accessTeamIds}
                    selectedUserIds={draft.accessUserIds}
                    onSelectedTeamIdsChange={accessTeamIds =>
                      setDraft(current => (current ? { ...current, accessTeamIds } : current))
                    }
                    onSelectedUserIdsChange={accessUserIds =>
                      setDraft(current => (current ? { ...current, accessUserIds } : current))
                    }
                  />
                </div>

                {saveError ? (
                  <div className="cu-banner cu-banner--error" role="alert">
                    {saveError}
                  </div>
                ) : null}

                <div className="cu-create-actions">
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost"
                    onClick={backToChannels}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="cu-btn cu-btn--secondary"
                    onClick={() => setStep(step < 2 ? step + 1 : step - 1)}
                    disabled={saving}
                  >
                    {step < 2 ? 'Continue' : 'Back'}
                  </button>
                  <button
                    type="submit"
                    className="cu-btn cu-btn--primary"
                    disabled={saving || !formDirty}
                  >
                    {saving ? 'Saving...' : 'Save changes'}
                  </button>
                </div>
              </CreateStepFlow>
            </form>
          ) : null}
        </CreateFlowPanel>
      </DashboardLayout>
      {confirmDialog}
    </AuthGate>
  )
}
