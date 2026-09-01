'use client'

import { useEffect, useMemo, useState } from 'react'
import { RecordList, RecordListRow, RowActionMenu } from '@clerum/frontend-components'
import { Button } from '@components/Button'
import { CheckboxField } from '@components/CheckboxField'
import { FormField } from '@components/FormField'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TextInput } from '@components/TextInput'
import { useToast } from '@components/Toast'
import { IconCopy, IconPencil, IconTrash } from '@components/icons'
import {
  approvalAccountDetailLabels,
  approvalAccountDisplayName,
  approvalAccountStatusLabel,
  challengeCountdownLabel,
  challengeRemainingSeconds,
  createWorkflowApprovalMediumChallenge,
  createWorkflowApprovalMediumLinkSession,
  providerBotHandle,
  slackVerificationCommand,
  targetDetailLabels,
  targetDisplayName,
  teamsVerificationCommand,
  telegramBotHandle,
  telegramVerificationCommand,
  updateWorkflowApprovalMediumDisplayName,
} from '@lib/approvalChannels'
import type {
  WorkflowApprovalMediumAccount,
  WorkflowApprovalMediumChallenge,
  WorkflowApprovalMediumLinkSession,
} from '@/app/types/approvalChannels'
import type { TelegramVerificationPanelProps } from './TelegramVerificationPanel.types'
import { APPROVAL_ACCOUNT_DISPLAY_NAME_MAX_LENGTH } from './constants'

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
  const [displayNameDraft, setDisplayNameDraft] = useState('')
  const [displayNameBusy, setDisplayNameBusy] = useState(false)
  const [displayNameError, setDisplayNameError] = useState('')
  const [teamsReplyInThreads, setTeamsReplyInThreads] = useState(true)
  const [teamsReplyInThreadsTouched, setTeamsReplyInThreadsTouched] = useState(false)
  const selectedTarget = useMemo(
    () => targets.find(target => target.id === selectedTargetId) ?? null,
    [selectedTargetId, targets]
  )
  const targetOptions = useMemo(
    () =>
      targets.map(target => ({
        value: target.id,
        label: targetDisplayName(target),
        description: targetDetailLabels(target).join(' · '),
      })),
    [targets]
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

  useEffect(() => {
    if (selectedTargetId && targets.some(target => target.id === selectedTargetId)) return
    setSelectedTargetId(targets.length === 1 ? targets[0]!.id : '')
  }, [selectedTargetId, targets])

  useEffect(() => {
    if (!pending) return
    setNowMs(Date.now())
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [pending])

  function openConnectionModal() {
    setError('')
    setPending(null)
    setSelectedTargetId(targets.length === 1 ? targets[0]!.id : '')
    setTeamsReplyInThreads(true)
    setTeamsReplyInThreadsTouched(false)
    setModalOpen(true)
  }

  function closeConnectionModal() {
    if (busy) return
    setModalOpen(false)
    void onAccountsRefresh().catch(() => undefined)
  }

  async function handleCopy(value: string, label: string) {
    await copyText(value)
    showToast(`${label} copied.`, { tone: 'success' })
  }

  function openDisplayNameModal(account: WorkflowApprovalMediumAccount) {
    setEditingAccount(account)
    setDisplayNameDraft(account.displayName?.trim() || approvalAccountDisplayName(account))
    setDisplayNameError('')
  }

  function closeDisplayNameModal() {
    if (displayNameBusy) return
    setEditingAccount(null)
    setDisplayNameDraft('')
    setDisplayNameError('')
  }

  async function saveDisplayName() {
    if (!editingAccount) return
    const nextDisplayName = displayNameDraft.trim()
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
      setDisplayNameDraft('')
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

  async function startConnection() {
    if (!selectedTargetId) return
    setBusy(true)
    setError('')
    try {
      if (medium === 'slack' || medium === 'teams') {
        const target = targets.find(item => item.id === selectedTargetId)
        const session = await createWorkflowApprovalMediumLinkSession({
          medium,
          targetId: selectedTargetId,
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
          targetId: selectedTargetId,
        })
        setNowMs(Date.now())
        setPending(challenge)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to start ${providerLabel} connection`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-social-channel-content">
      {error && !modalOpen ? <div className="message message--error">{error}</div> : null}
      {targets.length === 0 ? (
        <div className="message message--warning message--plain">
          No accessible {providerLabel} communication channel is available.
        </div>
      ) : (
        <div className="settings-social-channel-toolbar">
          <Button onClick={openConnectionModal} disabled={disabled}>
            Connect {providerLabel}
          </Button>
        </div>
      )}

      {accounts.length > 0 ? (
        <RecordList className="settings-target-list">
          {accounts.map(account => (
            <RecordListRow className="settings-target-row" key={account.id}>
              <div>
                <div className="settings-target-title">{approvalAccountDisplayName(account)}</div>
                <div className="settings-target-meta">
                  <span>{approvalAccountStatusLabel(account)}</span>
                  {approvalAccountDetailLabels(account).map(label => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              </div>
              <RowActionMenu
                ariaLabel={`Actions for ${approvalAccountDisplayName(account)}`}
                actions={[
                  {
                    key: 'edit',
                    label: 'Edit display name',
                    disabled,
                    onSelect: () => openDisplayNameModal(account),
                  },
                  {
                    key: 'delete',
                    label: account.disabledAt ? 'Remove record' : 'Delete connection',
                    danger: true,
                    disabled,
                    onSelect: () => onRemoveAccount(account.id, Boolean(account.disabledAt)),
                  },
                ]}
              />
            </RecordListRow>
          ))}
        </RecordList>
      ) : null}

      {modalOpen ? (
        <div
          className="cu-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeConnectionModal()
          }}
        >
          <section
            className="cu-modal-panel cu-modal-panel--narrow cu-modal-panel--dropdown-visible"
            role="dialog"
            aria-modal="true"
            aria-labelledby="telegram-connection-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <h3 id="telegram-connection-title" className="cu-modal-panel__title">
                {pending ? `Verify ${providerLabel}` : `Connect ${providerLabel}`}
              </h3>
              <button
                type="button"
                className="cu-btn cu-btn--ghost"
                onClick={closeConnectionModal}
                disabled={busy}
              >
                Close
              </button>
            </div>

            <div className="cu-modal-panel__body">
              {error ? <div className="message message--error">{error}</div> : null}

              {!pending ? (
                <div className="stack">
                  <FormField label="Communication channel">
                    <div className="small muted">Select a communication channel with an agent.</div>
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
                <div className="stack">
                  {activeTarget ? (
                    <div className="settings-verification-target">
                      <div>
                        <div className="small muted">Agent</div>
                        <div className="settings-target-title">{activeTarget.agentName}</div>
                      </div>
                      <div>
                        <div className="small muted">Communication channel</div>
                        <div className="settings-target-title">{activeTarget.channelName}</div>
                      </div>
                    </div>
                  ) : null}
                  {medium === 'teams' ? (
                    <div className="settings-verification-step">
                      <div className="settings-target-title">Verification scope</div>
                      <div className="small muted">
                        Verify once in any post to connect the entire Teams channel. The bot will
                        recognize you in every current and future post and thread in that channel.
                        Personal chats are connected separately.
                      </div>
                    </div>
                  ) : null}
                  <div className="settings-verification-step">
                    <div className="settings-target-title">Step 1</div>
                    {medium === 'telegram' ? (
                      <div className="small muted">
                        {`Message ${
                          botHandle || 'the selected bot'
                        } directly, or add it to a group, make it an administrator, and use that group.`}
                      </div>
                    ) : medium === 'teams' ? (
                      <div className="small muted">
                        Message {botHandle || 'the selected Microsoft Teams bot'} directly, or
                        mention it in any post in the Teams channel you want to connect.
                      </div>
                    ) : (
                      <div className="small muted">
                        Message {botHandle || `the selected ${providerLabel} App`} in the
                        conversation you want to connect.
                      </div>
                    )}
                    {botHandle ? (
                      <div className="settings-verification-token-row">
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
                    {activeTarget?.replyOnlyWhenMentioned ? (
                      <div className="small muted">
                        {medium === 'teams'
                          ? 'Mention the Microsoft Teams bot in each channel message so it responds.'
                          : medium === 'slack'
                            ? 'When using a channel, mention the Slack App in each message so it responds.'
                            : 'When adding the bot to a group, mention it in each message so it responds.'}
                      </div>
                    ) : null}
                  </div>
                  <div className="settings-verification-step">
                    <div className="settings-target-title">Step 2</div>
                    <div className="small muted">
                      {medium === 'teams'
                        ? 'Send this one-time code in any post in that Teams channel and mention the bot. You will not need to verify each post or thread.'
                        : medium !== 'telegram'
                          ? `Send this one-time code in that ${providerLabel} conversation. If you are using a channel, mention the app before the code.`
                          : `Send this verification code in ${providerLabel}.`}
                    </div>
                    {pendingCommand ? (
                      <div className="settings-verification-token-row">
                        <div className="token-box" data-testid={`${medium}-verification-command`}>
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
                  <div className="settings-verification-countdown" role="timer" aria-live="polite">
                    {remainingSeconds > 0
                      ? `Expires in ${challengeCountdownLabel(remainingSeconds)}`
                      : 'Code expired'}
                  </div>
                  <div className="small muted">
                    {medium === 'teams'
                      ? 'The Microsoft Teams bot replies when confirmation succeeds. Click Confirm when you are done.'
                      : medium !== 'telegram'
                        ? `The ${providerLabel} app replies when confirmation succeeds. Click Confirm when you are done.`
                        : `The bot replies in ${providerLower} when confirmation succeeds. Click Confirm when you are done.`}
                  </div>
                </div>
              )}
            </div>

            <div className="cu-modal-panel__foot">
              {!pending ? (
                <>
                  <Button variant="secondary" onClick={closeConnectionModal} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void startConnection()}
                    disabled={disabled || busy || !selectedTargetId}
                  >
                    {busy ? 'Starting...' : 'Continue'}
                  </Button>
                </>
              ) : remainingSeconds === 0 ? (
                <>
                  <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
                    Back
                  </Button>
                  <Button onClick={() => setPending(null)} disabled={busy}>
                    Generate new code
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
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

      {editingAccount ? (
        <div
          className="cu-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeDisplayNameModal()
          }}
        >
          <section
            className="cu-modal-panel cu-modal-panel--narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${medium}-display-name-title`}
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <h3 id={`${medium}-display-name-title`} className="cu-modal-panel__title">
                Edit conversation name
              </h3>
              <button
                type="button"
                className="cu-btn cu-btn--ghost"
                onClick={closeDisplayNameModal}
                disabled={displayNameBusy}
              >
                Close
              </button>
            </div>
            <div className="cu-modal-panel__body">
              <FormField label="Display name">
                <TextInput
                  value={displayNameDraft}
                  onChange={event => setDisplayNameDraft(event.target.value)}
                  placeholder={approvalAccountDisplayName(editingAccount)}
                  maxLength={APPROVAL_ACCOUNT_DISPLAY_NAME_MAX_LENGTH}
                  disabled={displayNameBusy}
                />
              </FormField>
              {displayNameError ? (
                <div className="message message--error">{displayNameError}</div>
              ) : null}
            </div>
            <div className="cu-modal-panel__foot">
              <Button
                variant="secondary"
                onClick={closeDisplayNameModal}
                disabled={displayNameBusy}
              >
                Cancel
              </Button>
              <Button onClick={() => void saveDisplayName()} disabled={displayNameBusy}>
                {displayNameBusy ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
