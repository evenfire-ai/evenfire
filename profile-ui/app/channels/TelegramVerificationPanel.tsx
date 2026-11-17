'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  DataTable,
  RowActionMenu,
  SingleValueEditDialog,
  TableHeaderCell,
  TableViewport,
} from '@clerum/frontend-components'
import { Button } from '@components/Button'
import { CheckboxField } from '@components/CheckboxField'
import { FormField } from '@components/FormField'
import { ModalCloseButton } from '@components/ModalCloseButton'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TextInput } from '@components/TextInput'
import { useToast } from '@components/Toast'
import {
  IconChatBubble,
  IconCopy,
  IconRobot,
  IconSlack,
  IconTelegram,
  IconTimer,
} from '@components/icons'
import {
  approvalAccountBotLabel,
  approvalAccountConversationTypeLabel,
  approvalAccountDisplayName,
  challengeCountdownLabel,
  challengeRemainingSeconds,
  channelTableRows,
  createWorkflowApprovalMediumChallenge,
  createWorkflowApprovalMediumLinkSession,
  providerBotHandle,
  slackVerificationCommand,
  targetDetailLabels,
  targetDisplayName,
  teamsVerificationCommand,
  telegramVerificationCommand,
  updateWorkflowApprovalMediumDisplayName,
} from '@lib/approvalChannels'
import type { ChannelTableRowStatus } from '@lib/approvalChannels'
import type {
  WorkflowApprovalMediumAccount,
  WorkflowApprovalMediumChallenge,
  WorkflowApprovalMediumLinkSession,
} from '@/app/types/approvalChannels'
import type { TelegramVerificationPanelProps } from './TelegramVerificationPanel.types'
import { APPROVAL_ACCOUNT_DISPLAY_NAME_MAX_LENGTH } from './constants'

const statusTagKeys: Record<ChannelTableRowStatus, string> = {
  Verified: 'verified',
  Disconnected: 'disconnected',
  'Not connected': 'not-connected',
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
  }
}

export function TelegramVerificationPanel({
  medium = 'telegram',
  targets,
  accounts,
  disabled,
  onAccountsRefresh,
  onRemoveAccount,
  connectRequestCount = 0,
}: TelegramVerificationPanelProps) {
  const { showToast } = useToast()
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedTargetId, setSelectedTargetId] = useState('')
  const [pending, setPending] = useState<
    WorkflowApprovalMediumChallenge | WorkflowApprovalMediumLinkSession | null
  >(null)
  const [nowMs, setNowMs] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editingAccount, setEditingAccount] = useState<WorkflowApprovalMediumAccount | null>(null)
  const [displayNameBusy, setDisplayNameBusy] = useState(false)
  const [displayNameError, setDisplayNameError] = useState('')
  const [teamsReplyInThreads, setTeamsReplyInThreads] = useState(true)
  const [teamsReplyInThreadsTouched, setTeamsReplyInThreadsTouched] = useState(false)
  const [bypassTargetSelection, setBypassTargetSelection] = useState(false)
  const selectedTarget = useMemo(
    () => targets.find(target => target.id === selectedTargetId) ?? null,
    [selectedTargetId, targets]
  )
  const rows = useMemo(() => channelTableRows(targets, accounts), [targets, accounts])
  const targetOptions = useMemo(
    () =>
      targets.map(target => {
        const description = targetDetailLabels(target).slice(1).join(' · ')
        const ProviderIcon =
          medium === 'telegram' ? IconTelegram : medium === 'slack' ? IconSlack : null
        if (!ProviderIcon) {
          return { value: target.id, label: targetDisplayName(target), description }
        }
        // The tab already names the provider, so the description skips it and
        // leads the agent with the agent badge and the handle with the
        // provider logo instead.
        return {
          value: target.id,
          label: targetDisplayName(target),
          description,
          descriptionNode: (
            <>
              {target.agentName ? (
                <>
                  <span className="cu-agent-badge">
                    <IconRobot width={10} height={10} />
                  </span>
                  <span>{target.agentName}</span>
                  {' · '}
                </>
              ) : null}
              <ProviderIcon className="cu-selection-dropdown__option-icon" width={12} height={12} />
              {providerBotHandle(target) ?? 'Bot handle unavailable'}
            </>
          ),
        }
      }),
    [medium, targets]
  )
  const pendingCommand = pending
    ? medium !== 'telegram' && 'nonce' in pending
      ? medium === 'teams'
        ? teamsVerificationCommand(pending)
        : slackVerificationCommand(pending)
      : 'code' in pending
        ? telegramVerificationCommand(pending)
        : null
    : null
  const activeTarget = pending?.target || selectedTarget
  const botHandle = providerBotHandle(activeTarget)
  const remainingSeconds = pending ? challengeRemainingSeconds(pending.expiresAt, nowMs) : 0
  const providerLabel =
    medium === 'slack' ? 'Slack' : medium === 'teams' ? 'Microsoft Teams' : 'Telegram'
  const providerLower = providerLabel.toLowerCase()
  const showTargetSelection = !pending && (!bypassTargetSelection || Boolean(error))
  const modalWide = Boolean(pending) || !showTargetSelection
  const eyebrowIcon =
    medium === 'telegram' ? (
      <IconTelegram width={20} height={20} />
    ) : medium === 'slack' ? (
      <IconSlack width={20} height={20} />
    ) : (
      <IconChatBubble width={20} height={20} />
    )
  const verifyTitle = `Verify your ${providerLabel} channel`
  const verifyDescription =
    medium === 'teams'
      ? 'Prove you control the Microsoft Teams bot by posting a verification code. It only takes a minute.'
      : medium === 'slack'
        ? 'Verify your Slack by sending a verification code. It only takes a minute.'
        : `Verify your ${providerLabel} by sending a verification code. It only takes a minute.`
  const stepOneTitle =
    medium === 'telegram'
      ? 'Message the verification bot'
      : medium === 'teams'
        ? 'Post in the Microsoft Teams channel'
        : 'Message the Slack app'
  const stepThreeText =
    medium === 'teams'
      ? 'The Microsoft Teams bot replies when confirmation succeeds. Click Confirm when you are done.'
      : medium !== 'telegram'
        ? `The ${providerLabel} app replies when confirmation succeeds. Click Confirm when you are done.`
        : `The bot replies in ${providerLower} when confirmation succeeds. Click Confirm when you are done.`

  useEffect(() => {
    if (selectedTargetId && targets.some(target => target.id === selectedTargetId)) return
    setSelectedTargetId(targets.length === 1 ? targets[0]!.id : '')
  }, [selectedTargetId, targets])

  const [handledConnectRequestCount, setHandledConnectRequestCount] = useState(connectRequestCount)
  useEffect(() => {
    if (connectRequestCount === handledConnectRequestCount) return
    setHandledConnectRequestCount(connectRequestCount)
    openConnectionModal()
  }, [connectRequestCount, handledConnectRequestCount])

  useEffect(() => {
    if (!pending) return
    setNowMs(Date.now())
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [pending])

  function openConnectionModal(preselectTargetId?: string, autoStart = false) {
    setError('')
    setPending(null)
    setBypassTargetSelection(autoStart)
    const nextTargetId = preselectTargetId || (targets.length === 1 ? targets[0]!.id : '')
    setSelectedTargetId(nextTargetId)
    setTeamsReplyInThreads(true)
    setTeamsReplyInThreadsTouched(false)
    setModalOpen(true)
    if (autoStart && nextTargetId) void startConnection(nextTargetId)
  }

  function closeConnectionModal() {
    if (busy) return
    setBypassTargetSelection(false)
    setModalOpen(false)
    void onAccountsRefresh().catch(() => undefined)
  }

  async function handleCopy(value: string, label: string) {
    await copyText(value)
    showToast(`${label} copied.`, { tone: 'success' })
  }

  function openDisplayNameModal(account: WorkflowApprovalMediumAccount) {
    setEditingAccount(account)
    setDisplayNameError('')
  }

  function closeDisplayNameModal() {
    if (displayNameBusy) return
    setEditingAccount(null)
    setDisplayNameError('')
  }

  async function saveDisplayName(value: string) {
    if (!editingAccount) return
    const nextDisplayName = value.trim()
    if (nextDisplayName.length > APPROVAL_ACCOUNT_DISPLAY_NAME_MAX_LENGTH) {
      setDisplayNameError(
        `Display name must be ${APPROVAL_ACCOUNT_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`
      )
      return
    }
    setDisplayNameBusy(true)
    setDisplayNameError('')
    try {
      await updateWorkflowApprovalMediumDisplayName(editingAccount.id, nextDisplayName)
      await onAccountsRefresh()
      setEditingAccount(null)
      setDisplayNameError('')
      showToast('Conversation display name saved.', { tone: 'success' })
    } catch (err) {
      setDisplayNameError(
        err instanceof Error ? err.message : 'Failed to save conversation display name'
      )
    } finally {
      setDisplayNameBusy(false)
    }
  }

  async function startConnection(targetIdOverride?: string) {
    const targetId = targetIdOverride ?? selectedTargetId
    if (!targetId) return
    setBusy(true)
    setError('')
    try {
      if (medium === 'slack' || medium === 'teams') {
        const target = targets.find(item => item.id === targetId)
        const session = await createWorkflowApprovalMediumLinkSession({
          medium,
          targetId,
          providerWorkspaceId: target?.providerWorkspaceId ?? null,
          ...(medium === 'teams' && teamsReplyInThreadsTouched
            ? { replyInThreads: teamsReplyInThreads }
            : {}),
        })
        setNowMs(Date.now())
        setPending(session)
      } else {
        const challenge = await createWorkflowApprovalMediumChallenge({
          medium: 'telegram',
          targetId,
        })
        setNowMs(Date.now())
        setPending(challenge)
      }
    } catch (err) {
      setBypassTargetSelection(false)
      setError(err instanceof Error ? err.message : `Failed to start ${providerLabel} connection`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-social-channel-content">
      {error && !modalOpen ? <div className="message message--error">{error}</div> : null}

      {rows.length === 0 ? (
        <div className="message message--warning message--plain">
          No {providerLabel} channels set up yet.
        </div>
      ) : (
        <TableViewport>
          <DataTable className="eft-table eft-table--wide">
            <thead>
              <tr>
                <TableHeaderCell label="Name" />
                <TableHeaderCell label="Chat type" />
                <TableHeaderCell label={medium === 'slack' ? 'App handle' : 'Bot handle'} />
                <TableHeaderCell label="Status" />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const name = row.account
                  ? approvalAccountDisplayName(row.account)
                  : targetDisplayName(row.target!)
                const notConnected = row.status === 'Not connected'
                const chatType = row.account
                  ? approvalAccountConversationTypeLabel(row.account)
                  : null
                const bot = row.account
                  ? approvalAccountBotLabel(row.account)
                  : (providerBotHandle(row.target) ?? '—')
                const rowDisabled = Boolean(row.account?.disabledAt)
                const ariaName = `Actions for ${name}`
                return (
                  <tr key={row.key}>
                    <td>{name}</td>
                    <td>
                      {notConnected ? (
                        <span
                          className={`cu-status-tag cu-status-tag--${statusTagKeys[row.status]}`}
                        >
                          Not connected
                        </span>
                      ) : (
                        chatType
                      )}
                    </td>
                    <td>{bot}</td>
                    <td>
                      <span className={`cu-status-tag cu-status-tag--${statusTagKeys[row.status]}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="eft-table__cell--actions">
                      <RowActionMenu
                        ariaLabel={ariaName}
                        actions={
                          row.account
                            ? [
                                ...(rowDisabled
                                  ? []
                                  : [
                                      {
                                        key: 'edit',
                                        label: 'Edit display name',
                                        disabled,
                                        onSelect: () => openDisplayNameModal(row.account!),
                                      },
                                    ]),
                                {
                                  key: 'delete',
                                  label: rowDisabled ? 'Remove record' : 'Delete connection',
                                  danger: true,
                                  disabled,
                                  onSelect: () => onRemoveAccount(row.account!.id, rowDisabled),
                                },
                              ]
                            : [
                                {
                                  key: 'connect',
                                  label: 'Connect',
                                  disabled,
                                  onSelect: () => openConnectionModal(row.target!.id, true),
                                },
                              ]
                        }
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        </TableViewport>
      )}

      {modalOpen ? (
        <div
          className="cu-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeConnectionModal()
          }}
        >
          <section
            className={`cu-modal-panel ${
              modalWide
                ? 'cu-modal-panel--wide cu-modal-panel--connect-flow'
                : 'cu-modal-panel--narrow'
            } cu-modal-panel--dropdown-visible`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="telegram-connection-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <div className="cu-connect-flow__head-title">
                <span className="cu-connect-flow__badge" aria-hidden="true">
                  {eyebrowIcon}
                </span>
                <h3 id="telegram-connection-title" className="cu-connect-flow__title">
                  {verifyTitle}
                </h3>
              </div>
              <ModalCloseButton onClose={closeConnectionModal} disabled={busy} />
            </div>

            <div className="cu-modal-panel__body">
              {error ? <div className="message message--error">{error}</div> : null}

              {!pending ? (
                showTargetSelection ? (
                  <div className="stack">
                    <FormField label="Communication channel">
                      <div className="small muted">
                        Select a communication channel with an agent.
                      </div>
                      <SelectionDropdown
                        id="telegram-target-select"
                        multiple={false}
                        value={selectedTargetId ? [selectedTargetId] : []}
                        onChange={next => setSelectedTargetId(next[0] || '')}
                        options={targetOptions}
                        placeholder="Select a communication channel with an agent"
                        searchPlaceholder="Search communication channels..."
                        emptyLabel={`No ${providerLabel} communication channels are available.`}
                        disabled={disabled || busy}
                      />
                    </FormField>
                    {medium === 'teams' ? (
                      <CheckboxField
                        checked={teamsReplyInThreads}
                        onChange={event => {
                          setTeamsReplyInThreadsTouched(true)
                          setTeamsReplyInThreads(event.target.checked)
                        }}
                        disabled={disabled || busy}
                        label="Reply in thread"
                        description="Keep bot replies, workflow approvals, and results in the Teams thread where the request started."
                      />
                    ) : null}
                  </div>
                ) : (
                  <div className="cu-connect-flow__loading" role="status">
                    <span
                      className="cu-btn__spinner cu-connect-flow__loading-spinner"
                      aria-hidden="true"
                    />
                    <span>Starting {providerLabel} verification...</span>
                  </div>
                )
              ) : (
                <div className="cu-connect-flow">
                  <div className="cu-connect-flow__main">
                    <p className="cu-connect-flow__description">{verifyDescription}</p>
                    {medium === 'teams' ? (
                      <p className="cu-connect-flow__description">
                        Verify once in any post to connect the entire Teams channel. The bot will
                        recognize you in every current and future post and thread in that channel.
                        Personal chats are connected separately.
                      </p>
                    ) : null}
                    {activeTarget ? (
                      <div className="cu-connect-card cu-connect-card--summary">
                        <div className="cu-connect-summary__item">
                          <span className="cu-agent-badge cu-agent-badge--card" aria-hidden="true">
                            <IconRobot />
                          </span>
                          <div className="stack">
                            <div className="small muted">Agent</div>
                            <div className="settings-target-title">{activeTarget.agentName}</div>
                          </div>
                        </div>
                        <div className="cu-connect-summary__item">
                          <span className="cu-connect-card__icon" aria-hidden="true">
                            <IconChatBubble width={18} height={18} />
                          </span>
                          <div className="stack">
                            <div className="small muted">Communication channel</div>
                            <div className="settings-target-title">{activeTarget.channelName}</div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    <ol className="cu-connect-flow__steps">
                      <li className="cu-connect-flow__step">
                        <span className="cu-connect-flow__step-number" aria-hidden="true">
                          1
                        </span>
                        <div className="cu-connect-flow__step-content">
                          <p className="cu-connect-flow__step-title">{stepOneTitle}</p>
                          <p className="cu-connect-flow__step-text">
                            {medium === 'telegram'
                              ? `Message ${
                                  botHandle || 'the selected bot'
                                } directly, or add it to a group, make it an administrator, and use that group.`
                              : medium === 'teams'
                                ? `Message ${
                                    botHandle || 'the selected Microsoft Teams bot'
                                  } directly, or mention it in any post in the Teams channel you want to connect.`
                                : `Message ${
                                    botHandle || `the selected ${providerLabel} App`
                                  } in the conversation you want to connect.`}
                          </p>
                          {activeTarget?.replyOnlyWhenMentioned ? (
                            <p className="cu-connect-flow__step-text">
                              {medium === 'teams'
                                ? 'Mention the Microsoft Teams bot in each channel message so it responds.'
                                : medium === 'slack'
                                  ? 'When using a channel, mention the Slack App in each message so it responds.'
                                  : 'When adding the bot to a group, mention it in each message so it responds.'}
                            </p>
                          ) : null}
                          {botHandle ? (
                            <div className="settings-verification-token-row cu-connect-flow__token-row">
                              <div className="token-box" data-testid={`${medium}-bot-handle`}>
                                {botHandle}
                              </div>
                              <Button
                                variant="secondary"
                                className="cu-btn--icon"
                                onClick={() =>
                                  void handleCopy(
                                    botHandle,
                                    medium === 'telegram'
                                      ? 'Bot handle'
                                      : medium === 'teams'
                                        ? 'Microsoft Teams bot name'
                                        : 'Slack App name'
                                  )
                                }
                                aria-label={
                                  medium === 'telegram'
                                    ? 'Copy bot handle'
                                    : medium === 'teams'
                                      ? 'Copy Microsoft Teams bot name'
                                      : 'Copy Slack App name'
                                }
                                title={
                                  medium === 'telegram'
                                    ? 'Copy bot handle'
                                    : medium === 'teams'
                                      ? 'Copy Microsoft Teams bot name'
                                      : 'Copy Slack App name'
                                }
                              >
                                <IconCopy />
                              </Button>
                            </div>
                          ) : (
                            <div className="message message--warning message--plain">
                              {medium === 'teams'
                                ? 'Microsoft Teams bot name is unavailable. Ask an administrator to update the communication channel.'
                                : medium === 'slack'
                                  ? 'Slack App name is unavailable. Ask an administrator to update the communication channel.'
                                  : 'Telegram bot handle is unavailable. Ask an administrator to update the communication channel.'}
                            </div>
                          )}
                        </div>
                      </li>
                      <li className="cu-connect-flow__step">
                        <span className="cu-connect-flow__step-number" aria-hidden="true">
                          2
                        </span>
                        <div className="cu-connect-flow__step-content">
                          <p className="cu-connect-flow__step-title">Send the verification code</p>
                          <p className="cu-connect-flow__step-text">
                            {medium === 'teams'
                              ? 'Send this one-time code in any post in that Teams channel and mention the bot. You will not need to verify each post or thread.'
                              : medium !== 'telegram'
                                ? `Send this one-time code in that ${providerLabel} conversation. If you are using a channel, mention the app before the code.`
                                : `Send this verification code in ${providerLabel}.`}
                          </p>
                          {pendingCommand ? (
                            <div className="settings-verification-token-row cu-connect-flow__token-row">
                              <div
                                className="token-box"
                                data-testid={`${medium}-verification-command`}
                              >
                                {pendingCommand}
                              </div>
                              <Button
                                variant="secondary"
                                className="cu-btn--icon"
                                onClick={() => void handleCopy(pendingCommand, 'Verification code')}
                                disabled={remainingSeconds === 0}
                                aria-label="Copy verification code"
                                title="Copy verification code"
                              >
                                <IconCopy />
                              </Button>
                            </div>
                          ) : (
                            <div className="message message--warning message--plain">
                              {providerLabel} verification code is unavailable. Generate a new code.
                            </div>
                          )}
                        </div>
                      </li>
                      <li className="cu-connect-flow__step">
                        <span className="cu-connect-flow__step-number" aria-hidden="true">
                          3
                        </span>
                        <div className="cu-connect-flow__step-content">
                          <p className="cu-connect-flow__step-title">Confirm here</p>
                          <p className="cu-connect-flow__step-text">{stepThreeText}</p>
                        </div>
                      </li>
                    </ol>
                  </div>
                </div>
              )}
            </div>

            <div className="cu-modal-panel__foot">
              {pending ? (
                <div className="cu-connect-flow__foot-timer" role="timer" aria-live="polite">
                  <IconTimer width={16} height={16} />
                  {remainingSeconds > 0 ? (
                    <>
                      <span className="cu-connect-card__countdown-label">Expires in</span>
                      <span className="settings-verification-countdown">
                        {challengeCountdownLabel(remainingSeconds)}
                      </span>
                    </>
                  ) : (
                    <span className="cu-connect-card__countdown-label">Code expired</span>
                  )}
                </div>
              ) : null}
              {!pending ? (
                <>
                  <Button variant="secondary" onClick={closeConnectionModal} disabled={busy}>
                    Cancel
                  </Button>
                  {showTargetSelection ? (
                    <Button
                      onClick={() => void startConnection()}
                      disabled={disabled || busy || !selectedTargetId}
                    >
                      {busy ? 'Starting...' : 'Continue'}
                    </Button>
                  ) : null}
                </>
              ) : remainingSeconds === 0 ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPending(null)
                      setBypassTargetSelection(false)
                    }}
                    disabled={busy}
                  >
                    Back
                  </Button>
                  <Button
                    onClick={() => {
                      setPending(null)
                      void startConnection(selectedTargetId)
                    }}
                    disabled={busy || !selectedTargetId}
                  >
                    Generate new code
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPending(null)
                      setBypassTargetSelection(false)
                    }}
                    disabled={busy}
                  >
                    Back
                  </Button>
                  <Button onClick={closeConnectionModal} disabled={busy}>
                    Confirm
                  </Button>
                </>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <SingleValueEditDialog
        discardLabel="Cancel"
        error={displayNameError || undefined}
        initialValue={
          editingAccount
            ? editingAccount.displayName?.trim() || approvalAccountDisplayName(editingAccount)
            : ''
        }
        onDismiss={closeDisplayNameModal}
        onSave={value => void saveDisplayName(value)}
        open={Boolean(editingAccount)}
        pending={displayNameBusy}
        renderEditor={({ value, onChange, disabled: editorDisabled }) => (
          <FormField label="Display name">
            <TextInput
              aria-label="Display name"
              disabled={editorDisabled}
              maxLength={APPROVAL_ACCOUNT_DISPLAY_NAME_MAX_LENGTH}
              onChange={event => onChange(event.target.value)}
              placeholder={editingAccount ? approvalAccountDisplayName(editingAccount) : ''}
              value={value}
            />
          </FormField>
        )}
        title="Edit conversation name"
      />
    </div>
  )
}
