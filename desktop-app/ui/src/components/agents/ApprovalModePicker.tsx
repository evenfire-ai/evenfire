import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button, Pill } from '@components/Common'
import { useClickOutside } from '@hooks/useClickOutside'
import { useHostApprovalMode } from '@hooks/useHostApprovalMode'
import type { ApprovalMode } from '@lib/hostApprovalModeStore'

export interface ApprovalModePickerProps {
  agentRef: string
  chatId: string
}

const ALLOW_ALL_CONFIRM =
  'Allow all runs tools in this chat without asking, except scheduled tasks. Continue?'
const FIRST_SEND_LOCK_HINT = 'The approval mode can change once the first message reaches the Host.'
const CLASSIFIER_NOTE = 'shell always asks on this model'
const WRITE_ERROR = 'The approval mode could not be saved.'

const MODE_OPTIONS: ReadonlyArray<{ mode: ApprovalMode; label: string; testId: string }> = [
  { mode: 'manual', label: 'Manual', testId: 'approval-mode-option-manual' },
  { mode: 'auto', label: 'Auto-approve', testId: 'approval-mode-option-auto' },
  { mode: 'allow_all', label: 'Allow all', testId: 'approval-mode-option-allow-all' },
]

/**
 * Session approval-mode control, sat next to the model selector in the
 * composer. It reuses the model selector's chip and upward popover so the two
 * controls read as one pair.
 * "Allow all" asks before it writes; the confirmation replaces the menu inside
 * the popover.
 * When the session's model cannot run the shell classifier and the mode is
 * auto, the chip turns warning-toned and says so in its tooltip and to screen
 * readers; the open menu says it too. Nothing is added to the composer row.
 * While the chat's first send is in flight the chip is disabled and an open
 * menu or confirmation closes: the store refuses the change in that window.
 */
export function ApprovalModePicker({ agentRef, chatId }: ApprovalModePickerProps) {
  const selectionChatId = chatId || null
  const { label, effectiveMode, shellClassifierAvailable, firstSendInFlight, selectMode } =
    useHostApprovalMode(agentRef, selectionChatId)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const classifierNoteId = useId()
  const chipLabel = label ?? 'Manual'
  const showClassifierNote = effectiveMode === 'auto' && shellClassifierAvailable === false
  const menuOpen = open && !firstSendInFlight

  const close = useCallback(() => {
    setOpen(false)
    setConfirming(false)
  }, [])

  useClickOutside(containerRef, menuOpen, close)

  // ESC closes the popover, matching the model selector.
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen, close])

  useEffect(() => {
    if (!firstSendInFlight) return
    close()
  }, [firstSendInFlight, close])

  // The composer mounts the picker un-keyed, so a chat or tab switch only
  // changes its props. Close the menu and the Allow-all confirmation, and drop
  // the save error, so nothing opened for one chat writes to or shows on the
  // next. A write still in flight for the old chat must not report here either.
  const chatScope = useRef(0)
  useEffect(() => {
    chatScope.current += 1
    close()
    setWriteError(null)
  }, [agentRef, chatId, close])

  const choose = (mode: ApprovalMode) => {
    close()
    const scope = chatScope.current
    void selectMode(mode).then(ok => {
      if (scope !== chatScope.current) return
      setWriteError(ok ? null : WRITE_ERROR)
    })
  }

  return (
    <div className="model-selector model-selector--up" ref={containerRef}>
      <Pill
        tone={showClassifierNote ? 'warning' : 'neutral'}
        size="sm"
        interactive={!firstSendInFlight}
        role="button"
        className={`model-selector-chip${firstSendInFlight ? ' model-selector-chip--disabled' : ''}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-disabled={firstSendInFlight || undefined}
        aria-label={`Approval mode — ${chipLabel}`}
        aria-describedby={showClassifierNote ? classifierNoteId : undefined}
        data-testid="approval-mode-picker"
        title={
          firstSendInFlight
            ? FIRST_SEND_LOCK_HINT
            : showClassifierNote
              ? `${chipLabel}: ${CLASSIFIER_NOTE}`
              : undefined
        }
        onClick={() => {
          if (firstSendInFlight) return
          setWriteError(null)
          setConfirming(false)
          setOpen(current => !current)
        }}
      >
        <span className="model-selector-chip-glyph" aria-hidden="true" />
        <span
          className="model-selector-chip-label"
          data-testid={label ? 'approval-mode-label' : undefined}
        >
          {chipLabel}
        </span>
        <svg
          className="model-selector-chip-caret"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path d={menuOpen ? 'm4.5 6 3.5 3.5L11.5 6' : 'm4.5 10 3.5-3.5L11.5 10'} />
        </svg>
      </Pill>
      {showClassifierNote ? (
        <span
          id={classifierNoteId}
          className="visually-hidden"
          data-testid="approval-mode-classifier-note"
        >
          {CLASSIFIER_NOTE}
        </span>
      ) : null}

      {writeError && !menuOpen ? (
        <span
          className="approval-mode-picker-error"
          data-testid="approval-mode-write-error"
          role="alert"
        >
          {writeError}
        </span>
      ) : null}

      {menuOpen && confirming ? (
        <div className="model-selector-popover" role="dialog" aria-label="Confirm allow all">
          <p className="approval-mode-picker-confirm-text">{ALLOW_ALL_CONFIRM}</p>
          <div className="approval-mode-picker-confirm-actions">
            <Button
              size="xs"
              variant="ghost"
              color="neutral"
              data-testid="approval-mode-cancel-allow-all"
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant="solid"
              color="primary"
              data-testid="approval-mode-confirm-allow-all"
              onClick={() => choose('allow_all')}
            >
              Allow all
            </Button>
          </div>
        </div>
      ) : null}

      {menuOpen && !confirming ? (
        <div className="model-selector-popover" role="menu" aria-label="Select approval mode">
          {shellClassifierAvailable === false ? (
            <p
              className="model-selector-notice model-selector-notice--warning"
              data-testid="approval-mode-classifier-menu-note"
            >
              Shell always asks on this model.
            </p>
          ) : null}
          <ul className="model-selector-list">
            {MODE_OPTIONS.map(option => {
              const isActive = option.mode === effectiveMode
              return (
                <li key={option.mode}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    data-testid={option.testId}
                    className={`model-selector-item${isActive ? ' model-selector-item--active' : ''}`}
                    onClick={() =>
                      option.mode === 'allow_all' ? setConfirming(true) : choose(option.mode)
                    }
                  >
                    <span className="model-selector-item-label">{option.label}</span>
                    {isActive ? (
                      <svg
                        className="model-selector-item-check"
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="m3.5 8.5 3 3 6-6" />
                      </svg>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
