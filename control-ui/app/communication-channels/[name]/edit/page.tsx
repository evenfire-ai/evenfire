'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { FormSectionsSkeleton } from '@components/BodyLoadingSkeleton'
import { ChannelCredentialsPanel } from '@components/ChannelCredentialsPanel'
import { CommunicationChannelAccessSelector } from '@components/CommunicationChannelAccessSelector'
import { CommunicationChannelConversationsTable } from '@components/CommunicationChannelConversations'
import type { CommunicationChannelConversation } from '@components/CommunicationChannelConversations/types'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { SegmentedControl } from '@components/SegmentedControl'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconBroadcast } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconCopy } from '@components/icons'
import { Button } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { apiGet, apiSend, isSilentApiError } from '@lib/api'
import type { ChannelType } from '@lib/channelTypes'
import { copyTextToClipboard } from '@lib/clipboard'
import {
  type CommunicationChannelDraftState,
  buildCommunicationChannelSpec,
  communicationChannelInitialTab,
  createCommunicationChannelDraft,
  hasSlackConfigForRequestUrl,
} from '@lib/communicationChannelEdit'
import {
  COMMUNICATION_CHANNEL_PROVIDERS,
  COMMUNICATION_CHANNEL_PROVIDER_OPTIONS,
  type CommunicationChannelProvider,
  communicationChannelProviderServiceLabel,
} from '@lib/communicationChannelProviders'
import {
  type CommunicationChannelItem,
  slackWebhookUrlForChannelName,
  teamsWebhookUrlForChannel,
} from '@lib/communicationChannels'
import { canGenerateSlackAppManifest, slackAppManifest } from '@lib/slackAppManifest'

type ChannelProvider = CommunicationChannelProvider
type DraftState = CommunicationChannelDraftState

const DEFAULT_SLACK_APP_NAME = 'Evenfire'

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
  const [activeTab, setActiveTab] = useState<ChannelProvider>('telegram')
  const [hosts, setHosts] = useState<HostItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  function backToChannels() {
    router.push(CONTROL_ROUTES.externalChannels.root)
  }

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
        setDraft(createCommunicationChannelDraft(nextItem))
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
  }, [name])

  const visibleChannelTypes = useMemo<ChannelType[]>(() => [activeTab], [activeTab])
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
  const teamsRequestUrl = item ? teamsWebhookUrlForChannel(item) : null
  // A relative request_url is invalid to Slack, so warn instead of handing over a manifest that
  // cannot work. slackWebhookUrlForChannelName falls back to a bare path when the deployment has
  // no public webhook address.
  const slackManifest =
    slackRequestUrl && canGenerateSlackAppManifest(slackRequestUrl)
      ? slackAppManifest(draft?.slackBotHandle.trim() || DEFAULT_SLACK_APP_NAME, slackRequestUrl)
      : null

  async function persistDraft(nextDraft: DraftState, successMessage: string) {
    setSaving(true)
    setSaveError('')
    try {
      await apiSend('PUT', `/api/v1/admin/communication-channels/${encodeURIComponent(name)}`, {
        spec: buildCommunicationChannelSpec(nextDraft),
      })
      setDraft(nextDraft)
      showToast(successMessage, { tone: 'success' })
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save communication channel')
    } finally {
      setSaving(false)
    }
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft || saving) return
    await persistDraft(draft, `Communication channel ${name} updated.`)
    backToChannels()
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

  async function copySlackRequestUrl() {
    if (!slackRequestUrl) return
    const copied = await copyTextToClipboard(slackRequestUrl)
    showToast(
      copied
        ? 'Slack Request URL copied.'
        : 'Could not copy to clipboard. Select the URL and copy it manually.',
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

  async function copyTeamsRequestUrl() {
    if (!teamsRequestUrl) return
    const copied = await copyTextToClipboard(teamsRequestUrl)
    showToast(
      copied
        ? 'Teams Request URL copied.'
        : 'Could not copy to clipboard. Select the URL and copy it manually.',
      { tone: copied ? 'success' : 'error' }
    )
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
              label="Communication channel"
              primaryActionLabel="Save channel"
              sections={3}
            />
          ) : loadError ? (
            <div className="cu-create-content">
              <div className="cu-banner cu-banner--error" role="alert">
                {loadError}
              </div>
            </div>
          ) : item && draft ? (
            <form className="cu-create-content cu-channel-edit-form" onSubmit={handleSave}>
              <div className="cu-field">
                <label htmlFor="ch-host-ref">Agent reference</label>
                <SelectionDropdown
                  id="ch-host-ref"
                  multiple={false}
                  value={draft.hostRef ? [draft.hostRef] : []}
                  onChange={next =>
                    setDraft(current =>
                      current
                        ? {
                            ...current,
                            accessTeamIds:
                              current.hostRef === (next[0] || '') ? current.accessTeamIds : [],
                            accessUserIds:
                              current.hostRef === (next[0] || '') ? current.accessUserIds : [],
                            hostRef: next[0] || '',
                          }
                        : current
                    )
                  }
                  options={hosts.map(host => ({
                    value: host.metadata?.name || '',
                    label: host.metadata?.name || '-',
                    description: host.metadata?.namespace || 'default',
                  }))}
                  placeholder="Select an agent..."
                  searchPlaceholder="Search agents..."
                  emptyLabel="No available agents."
                  disabled={saving}
                />
                <span className="cu-field__hint">
                  Changing the agent clears communication access until you reselect users or teams.
                </span>
              </div>

              <SegmentedControl<ChannelProvider>
                ariaLabel="Communication channel providers"
                value={activeTab}
                className="cu-segmented-control--flush cu-segmented-control--full"
                disabled={saving}
                onChange={setActiveTab}
                options={COMMUNICATION_CHANNEL_PROVIDER_OPTIONS}
              />

              <section className="cu-channel-provider-panel">
                <div className="cu-channel-provider-panel__head">
                  <div>
                    <p className="cu-section-title">
                      {communicationChannelProviderServiceLabel(activeTab)}
                    </p>
                    <p className="cu-muted">
                      {activeTab === 'slack'
                        ? 'Slack app credentials are write-only. Rotate regenerated values here.'
                        : 'Credentials are write-only. Stored values render masked and can be rotated.'}
                    </p>
                  </div>
                </div>
                <label className="cu-toggle-row">
                  <input
                    type="checkbox"
                    checked={
                      activeTab === 'telegram'
                        ? draft.telegramReplyOnlyWhenMentioned
                        : activeTab === 'slack'
                          ? draft.slackReplyOnlyWhenMentioned
                          : draft.teamsReplyOnlyWhenMentioned
                    }
                    disabled={saving}
                    onChange={event =>
                      setDraft(current =>
                        current
                          ? activeTab === 'telegram'
                            ? {
                                ...current,
                                telegramReplyOnlyWhenMentioned: event.target.checked,
                              }
                            : activeTab === 'slack'
                              ? { ...current, slackReplyOnlyWhenMentioned: event.target.checked }
                              : { ...current, teamsReplyOnlyWhenMentioned: event.target.checked }
                          : current
                      )
                    }
                  />
                  <span>
                    Answer only when the {activeTab === 'slack' ? 'app' : 'bot'} is mentioned
                  </span>
                </label>
                {activeTab === 'slack' ? (
                  <label className="cu-toggle-row">
                    <input
                      type="checkbox"
                      checked={draft.slackReplyInThreads}
                      disabled={saving}
                      onChange={event =>
                        setDraft(current =>
                          current
                            ? { ...current, slackReplyInThreads: event.target.checked }
                            : current
                        )
                      }
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
                {activeTab === 'telegram' ? (
                  <div className="cu-field">
                    <label htmlFor="telegram-bot-handle">
                      Telegram bot handle{' '}
                      <span
                        className="cu-help-tooltip"
                        tabIndex={0}
                        aria-label="We use this handle to show users which Telegram bot to message when connecting their account or a group."
                        data-tooltip="We use this handle to show users which Telegram bot to message when connecting their account or a group."
                      >
                        ?
                      </span>
                    </label>
                    <input
                      id="telegram-bot-handle"
                      className="cu-input"
                      value={draft.telegramBotHandle}
                      onChange={event =>
                        setDraft(current =>
                          current ? { ...current, telegramBotHandle: event.target.value } : current
                        )
                      }
                      placeholder="@your_bot"
                      disabled={saving}
                      autoComplete="off"
                    />
                    <span className="cu-field__hint">
                      Public bot username, with or without the leading @.
                    </span>
                  </div>
                ) : activeTab === 'slack' ? (
                  <>
                    <div className="cu-banner cu-banner--info">
                      Store the Slack app Signing Secret and Bot User OAuth token here. The Signing
                      Secret verifies Slack requests; the bot token lets us read and reply through
                      the Slack Web API. The workspace is detected when a user verifies a Slack
                      conversation.
                    </div>
                    <div className="cu-field">
                      <label htmlFor="slack-bot-handle">
                        Slack App Name{' '}
                        <span
                          className="cu-help-tooltip"
                          tabIndex={0}
                          aria-label="We use this name to show users which Slack App to message"
                          data-tooltip="We use this name to show users which Slack App to message"
                        >
                          ?
                        </span>
                      </label>
                      <input
                        id="slack-bot-handle"
                        className="cu-input"
                        value={draft.slackBotHandle}
                        onChange={event =>
                          setDraft(current =>
                            current
                              ? {
                                  ...current,
                                  slackBotHandle: event.target.value,
                                  // Typed, so no longer just an inherited label.
                                  slackBotHandleFromAnnotation: false,
                                }
                              : current
                          )
                        }
                        placeholder="Your Slack App"
                        disabled={saving}
                        autoComplete="off"
                      />
                      <span className="cu-field__hint">
                        Slack App name shown in Profile UI setup instructions.
                      </span>
                    </div>
                    <div className="cu-field">
                      <span className="cu-field__label">Slack Request URL</span>
                      <div className="cu-copy-field">
                        <div className="cu-readonly-field cu-copy-field__value">
                          {slackRequestUrl || 'Available once this channel has a Slack App Name'}
                        </div>
                        <button
                          type="button"
                          className="cu-btn cu-btn--secondary"
                          onClick={copySlackRequestUrl}
                          disabled={!slackRequestUrl || saving}
                        >
                          Copy
                        </button>
                      </div>
                      <span className="cu-field__hint">
                        {slackRequestUrl
                          ? 'Use this URL for Slack Event Subscriptions and Interactivity.'
                          : 'Enter the Slack App Name above and this channel gets its Request URL and app manifest.'}
                      </span>
                    </div>
                    {slackRequestUrl ? (
                      slackManifest ? (
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
                            Paste this into Slack, either at Create New App → From an app manifest
                            for a new app, or in an existing app under Settings → App Manifest. It
                            fills in both Request URLs, on Event Subscriptions and on Interactivity
                            &amp; Shortcuts. Setting only Event Subscriptions leaves approval
                            buttons dead with nothing in the logs.
                          </span>
                        </div>
                      ) : (
                        <div className="cu-banner cu-banner--warning">
                          No app manifest: this deployment has no public webhook address, so the
                          Request URL above is a path and Slack cannot reach it. Expose the webhook
                          proxy publicly and set NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL to
                          that address, or prefix the path with it by hand in Slack.
                        </div>
                      )
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="cu-banner cu-banner--info">
                      Store the CLIENT_SECRET value here, not the Microsoft secret ID. CLIENT_ID and
                      TENANT_ID identify the Microsoft Teams bot that receives messages for this
                      channel.
                    </div>
                    <div className="cu-field">
                      <label htmlFor="teams-app-name">Name</label>
                      <input
                        id="teams-app-name"
                        className="cu-input"
                        value={draft.teamsAppName}
                        onChange={event =>
                          setDraft(current =>
                            current ? { ...current, teamsAppName: event.target.value } : current
                          )
                        }
                        placeholder="Your Teams Bot"
                        disabled={saving}
                        autoComplete="off"
                      />
                      <span className="cu-field__hint">
                        Name shown in the Teams bot creation output and Profile UI setup
                        instructions.
                      </span>
                    </div>
                    <div className="cu-field">
                      <label htmlFor="teams-app-id">CLIENT_ID</label>
                      <input
                        id="teams-app-id"
                        className="cu-input"
                        value={draft.teamsAppId}
                        onChange={event =>
                          setDraft(current =>
                            current ? { ...current, teamsAppId: event.target.value } : current
                          )
                        }
                        placeholder="00000000-0000-0000-0000-000000000000"
                        disabled={saving}
                        autoComplete="off"
                      />
                      <span className="cu-field__hint">
                        CLIENT_ID from the generated .env file.
                      </span>
                    </div>
                    <div className="cu-field">
                      <label htmlFor="teams-tenant-id">TENANT_ID</label>
                      <input
                        id="teams-tenant-id"
                        className="cu-input"
                        value={draft.teamsTenantId}
                        onChange={event =>
                          setDraft(current =>
                            current ? { ...current, teamsTenantId: event.target.value } : current
                          )
                        }
                        placeholder="00000000-0000-0000-0000-000000000000"
                        disabled={saving}
                        autoComplete="off"
                      />
                      <span className="cu-field__hint">
                        TENANT_ID from the generated .env file.
                      </span>
                    </div>
                    <div className="cu-field">
                      <span className="cu-field__label">Teams Request URL</span>
                      <div className="cu-copy-field">
                        <div className="cu-readonly-field cu-copy-field__value">
                          {teamsRequestUrl || 'Unavailable'}
                        </div>
                        <button
                          type="button"
                          className="cu-btn cu-btn--secondary"
                          onClick={copyTeamsRequestUrl}
                          disabled={!teamsRequestUrl || saving}
                        >
                          Copy
                        </button>
                      </div>
                      <span className="cu-field__hint">
                        Use this URL as the Messaging endpoint for the Teams bot app.
                      </span>
                    </div>
                  </>
                )}
                <ChannelCredentialsPanel
                  ccName={item.metadata?.name || name}
                  visibleChannelTypes={visibleChannelTypes}
                  hasStoredCredentials={!!draft.credentialsSecretRef?.name}
                />
              </section>

              <CommunicationChannelAccessSelector
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
                <button type="submit" className="cu-btn cu-btn--primary" disabled={saving}>
                  {saving ? 'Saving...' : 'Save changes'}
                </button>
              </div>
            </form>
          ) : null}
        </CreateFlowPanel>
      </DashboardLayout>
      {confirmDialog}
    </AuthGate>
  )
}
