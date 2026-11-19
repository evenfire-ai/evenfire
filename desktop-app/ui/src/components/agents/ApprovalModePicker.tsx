import { useEffect, useState } from 'react'
import { useHostApprovalMode } from '@hooks/useHostApprovalMode'
import type { ApprovalMode } from '@lib/hostApprovalModeStore'

export interface ApprovalModePickerProps {
  agentRef: string
  chatId: string
}

const ALLOW_ALL_CONFIRM =
  'Allow all runs tools in this chat without asking, except scheduled tasks. Continue?'
const FIRST_SEND_LOCK_HINT = 'The approval mode can change once the first message reaches the Host.'

/**
 * Session approval-mode control, sat next to the model selector.
 * "Allow all" asks before it writes. Auto and allow-all keep a visible label.
 * When the session's model cannot run the shell classifier, say so next to
 * Auto-approve: shell still asks.
 * While the chat's first send is in flight the control is disabled and an open
 * menu or confirmation closes: the store refuses the change in that window.
 */
export function ApprovalModePicker({ agentRef, chatId }: ApprovalModePickerProps) {
  const selectionChatId = chatId || null
  const { label, effectiveMode, shellClassifierAvailable, firstSendInFlight, selectMode } =
    useHostApprovalMode(agentRef, selectionChatId)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const showClassifierNote = effectiveMode === 'auto' && shellClassifierAvailable === false

  useEffect(() => {
    if (!firstSendInFlight) return
    setOpen(false)
    setConfirming(false)
  }, [firstSendInFlight])

  const choose = (mode: ApprovalMode) => {
    setOpen(false)
    setConfirming(false)
    void selectMode(mode).then(ok => {
      setWriteError(ok ? null : 'The approval mode could not be saved.')
    })
  }

  return (
    <div className="approval-mode-picker">
      {label ? (
        <span data-testid="approval-mode-label" className="approval-mode-picker-label">
          {label}
        </span>
      ) : null}
      {showClassifierNote ? (
        <p data-testid="approval-mode-classifier-note" role="note">
          shell always asks on this model
        </p>
      ) : null}
      {writeError ? (
        <p data-testid="approval-mode-write-error" role="alert">
          {writeError}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="approval-mode-picker"
        aria-haspopup="menu"
        aria-expanded={open && !firstSendInFlight}
        disabled={firstSendInFlight}
        title={firstSendInFlight ? FIRST_SEND_LOCK_HINT : undefined}
        onClick={() => {
          setConfirming(false)
          setOpen(current => !current)
        }}
      >
        {label ?? 'Manual'}
      </button>
      {open && !confirming && !firstSendInFlight ? (
        <div role="menu">
          <button
            type="button"
            role="menuitem"
            data-testid="approval-mode-option-manual"
            onClick={() => choose('manual')}
          >
            Manual
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="approval-mode-option-auto"
            onClick={() => choose('auto')}
          >
            Auto-approve
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="approval-mode-option-allow-all"
            onClick={() => setConfirming(true)}
          >
            Allow all
          </button>
        </div>
      ) : null}
      {confirming && !firstSendInFlight ? (
        <div role="dialog" aria-label="Confirm allow all">
          <p>{ALLOW_ALL_CONFIRM}</p>
          <button
            type="button"
            data-testid="approval-mode-cancel-allow-all"
            onClick={() => {
              setConfirming(false)
              setOpen(false)
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="approval-mode-confirm-allow-all"
            onClick={() => choose('allow_all')}
          >
            Allow all
          </button>
        </div>
      ) : null}
    </div>
  )
}
