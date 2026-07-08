'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@components/Button'
import { FormField } from '@components/FormField'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { useToast } from '@components/Toast'
import { IconCopy } from '@components/icons'
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
  telegramBotHandle,
  telegramVerificationCommand,
} from '@lib/approvalChannels'
import type {
  WorkflowApprovalMediumChallenge,
  WorkflowApprovalMediumLinkSession,
} from '@/app/types/approvalChannels'
import type { TelegramVerificationPanelProps } from './TelegramVerificationPanel.types'

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
    ? medium === 'slack' && 'nonce' in pending
      ? slackVerificationCommand(pending)
      : 'code' in pending
        ? telegramVerificationCommand(pending)
        : null
    : null
  const activeTarget = pending?.target || selectedTarget
  const botHandle = providerBotHandle(activeTarget)
  const remainingSeconds = pending ? challengeRemainingSeconds(pending.expiresAt, nowMs) : 0
  const providerLabel = medium === 'slack' ? 'Slack' : 'Telegram'
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

  async function startConnection() {
    if (!selectedTargetId) return
    setBusy(true)
    setError('')
    try {
      if (medium === 'slack') {
        const target = targets.find(item => item.id === selectedTargetId)
        const session = await createWorkflowApprovalMediumLinkSession({
          medium: 'slack',
          targetId: selectedTargetId,
          providerWorkspaceId: target?.providerWorkspaceId ?? null,
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
        <div className="settings-target-list">
          {accounts.map(account => (
            <div className="settings-target-row" key={account.id}>
              <div>
                <div className="settings-target-title">{approvalAccountDisplayName(account)}</div>
                <div className="settings-target-meta">
                  <span>{approvalAccountStatusLabel(account)}</span>
                  {approvalAccountDetailLabels(account).map(label => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              </div>
              <Button
                variant="danger"
                onClick={() => onRemoveAccount(account.id, Boolean(account.disabledAt))}
                disabled={disabled}
              >
                {account.disabledAt ? 'Remove record' : 'Delete'}
              </Button>
            </div>
          ))}
        </div>
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
                  <div className="settings-verification-step">
                    <div className="settings-target-title">Step 1</div>
                    {medium === 'telegram' ? (
                      <div className="small muted">
                        {`Message ${
                          botHandle || 'the selected bot'
                        } directly, or add it to a group, make it an administrator, and use that group.`}
                      </div>
                    ) : null}
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
                              medium === 'slack' ? 'Slack App name' : 'Bot handle'
                            )
                          }
                          aria-label={
                            medium === 'slack' ? 'Copy Slack App name' : 'Copy bot handle'
                          }
                          title={medium === 'slack' ? 'Copy Slack App name' : 'Copy bot handle'}
                        >
                          <IconCopy />
                        </Button>
                      </div>
                    ) : (
                      <div className="message message--warning message--plain">
                        {medium === 'slack'
                          ? 'Slack App name is unavailable. Ask an administrator to update the communication channel.'
                          : `${providerLabel} bot handle is unavailable. Ask an administrator to update the communication channel.`}
                      </div>
                    )}
                    {activeTarget?.replyOnlyWhenMentioned ? (
                      <div className="small muted">
                        {medium === 'slack'
                          ? 'When using a channel, mention the Slack App in each message so it responds.'
                          : 'When adding the bot to a group, mention it in each message so it responds.'}
                      </div>
                    ) : null}
                  </div>
                  <div className="settings-verification-step">
                    <div className="settings-target-title">Step 2</div>
                    <div className="small muted">
                      {medium === 'slack'
                        ? 'Send this one-time code in that Slack conversation. If you are using a channel, mention the Slack App before the code.'
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
                    {medium === 'slack'
                      ? 'The Slack app replies when confirmation succeeds. Click Confirm when you are done.'
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
    </div>
  )
}
