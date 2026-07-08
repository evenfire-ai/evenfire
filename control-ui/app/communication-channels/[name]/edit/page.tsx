'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { ChannelCredentialsPanel } from '@components/ChannelCredentialsPanel'
import { CommunicationChannelAccessSelector } from '@components/CommunicationChannelAccessSelector'
import { CommunicationChannelConversationsTable } from '@components/CommunicationChannelConversations'
import type { CommunicationChannelConversation } from '@components/CommunicationChannelConversations/types'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconBroadcast } from '@components/Sidebar/icons'
import { TabBar } from '@components/TabBar'
import { useToast } from '@components/Toast'
import { apiGet, apiSend, isSilentApiError } from '@lib/api'
import type { ChannelType } from '@lib/channelTypes'
import { copyTextToClipboard } from '@lib/clipboard'
import {
  type CommunicationChannelDraftState,
  buildCommunicationChannelSpec,
  communicationChannelInitialTab,
  createCommunicationChannelDraft,
} from '@lib/communicationChannelEdit'
import {
  type CommunicationChannelItem,
  slackWebhookUrlForChannel,
} from '@lib/communicationChannels'

type ChannelProvider = Extract<ChannelType, 'telegram' | 'slack'>
type DraftState = CommunicationChannelDraftState

type HostItem = {
  metadata?: { name?: string; namespace?: string }
}

type HostsResponse = {
  hosts?: HostItem[]
  items?: HostItem[]
}

const CHANNEL_PROVIDERS: readonly ChannelProvider[] = ['telegram', 'slack'] as const

function labelForProvider(type: ChannelProvider): string {
  return type === 'telegram' ? 'Telegram' : 'Slack'
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
  return (provider === 'telegram' ? draft.telegram : draft.slack).map(group => ({
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
    router.push('/communication-channels')
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
  const slackRequestUrl = item ? slackWebhookUrlForChannel(item) : null

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
        : {
            ...draft,
            slack: draft.slack.filter(group => group.channelId !== conversation.channelId),
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
            <div className="cu-create-content">Loading communication channel...</div>
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

              <TabBar<ChannelProvider>
                ariaLabel="Communication channel providers"
                activeValue={activeTab}
                className="cu-tabs--flush"
                onChange={setActiveTab}
                options={CHANNEL_PROVIDERS.map(type => ({
                  value: type,
                  label: labelForProvider(type),
                  disabled: saving,
                }))}
              />

              <section className="cu-channel-provider-panel">
                <div className="cu-channel-provider-panel__head">
                  <div>
                    <p className="cu-section-title">
                      {activeTab === 'slack' ? 'Slack app' : `${labelForProvider(activeTab)} bot`}
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
                        : draft.slackReplyOnlyWhenMentioned
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
                            : { ...current, slackReplyOnlyWhenMentioned: event.target.checked }
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
                ) : (
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
                            current ? { ...current, slackBotHandle: event.target.value } : current
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
                          {slackRequestUrl || 'Unavailable'}
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
                        Use this URL for Slack Event Subscriptions and Interactivity.
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
