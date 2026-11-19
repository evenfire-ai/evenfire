import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
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
 *
 * "Allow all" asks before it writes; the confirmation replaces the menu inside
 * the popover, takes focus, keeps Tab inside, and hands focus back to the chip.
 *
 * The composer mounts the picker without a key, so a chat switch only changes
 * its props. The menu and the confirmation reset during that render, so nothing
 * opened for one chat ever shows or acts on the next. The same happens when the
 * chat's first send starts: the store refuses a change in that window.
 *
 * Whether the chat's latest pick was not saved lives in the approval-mode
 * store, per chat, so the error follows the chat across switches and remounts.
 * Opening the menu again clears it.
 *
 * When the session's model cannot run the shell classifier and the mode is
 * auto, the chip turns warning-toned and says so in its tooltip and to screen
 * readers; the open menu says it too.
 */
export function ApprovalModePicker({ agentRef, chatId }: ApprovalModePickerProps) {
  const selectionChatId = chatId || null
  const {
    label,
    effectiveMode,
    shellClassifierAvailable,
    firstSendInFlight,
    saveFailed,
    selectMode,
    clearSaveFailure,
  } = useHostApprovalMode(agentRef, selectionChatId)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const classifierNoteId = useId()

  // Reset during render, not in an effect: a passive effect would commit the
  // previous chat's menu under the next chat first, and could undo a click
  // that lands before it runs.
  const scopeKey = `${agentRef}::${selectionChatId ?? ''}`
  const [renderedFor, setRenderedFor] = useState({ scopeKey, locked: firstSendInFlight })
  if (renderedFor.scopeKey !== scopeKey || renderedFor.locked !== firstSendInFlight) {
    if (renderedFor.scopeKey !== scopeKey || (firstSendInFlight && !renderedFor.locked)) {
      setOpen(false)
      setConfirming(false)
    }
    setRenderedFor({ scopeKey, locked: firstSendInFlight })
  }

  const chipLabel = label ?? 'Manual'
  const showClassifierNote = effectiveMode === 'auto' && shellClassifierAvailable === false
  const menuOpen = open && !firstSendInFlight

  const close = useCallback(() => {
    setOpen(false)
    setConfirming(false)
  }, [])

  const focusChip = useCallback(() => {
    containerRef.current?.querySelector<HTMLElement>('.model-selector-chip')?.focus()
  }, [])

  // A pointer elsewhere closes the menu and leaves focus where the user clicked.
  useClickOutside(containerRef, menuOpen, close)

  // ESC closes the popover, matching the model selector, and hands focus back.
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      close()
      focusChip()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen, close, focusChip])

  const choose = (mode: ApprovalMode) => {
    close()
    focusChip()
    void selectMode(mode)
  }

  // Tab and Shift+Tab wrap between the two buttons, also when a click on the
  // text left focus on the confirmation itself.
  const keepFocusInConfirmation = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const active = document.activeElement
    const fromContainer = active === event.currentTarget
    if (event.shiftKey && (fromContainer || active === cancelRef.current)) {
      event.preventDefault()
      confirmRef.current?.focus()
    } else if (!event.shiftKey && (fromContainer || active === confirmRef.current)) {
      event.preventDefault()
      cancelRef.current?.focus()
    }
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
          if (!open) clearSaveFailure()
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

      {saveFailed && !menuOpen ? (
        <span
          className="approval-mode-picker-error"
          data-testid="approval-mode-write-error"
          role="alert"
        >
          {WRITE_ERROR}
        </span>
      ) : null}

      {menuOpen && confirming ? (
        <div
          className="model-selector-popover"
          role="dialog"
          aria-label="Confirm allow all"
          tabIndex={-1}
          onKeyDown={keepFocusInConfirmation}
        >
          <p className="approval-mode-picker-confirm-text">{ALLOW_ALL_CONFIRM}</p>
          <div className="approval-mode-picker-confirm-actions">
            <Button
              ref={cancelRef}
              autoFocus
              size="xs"
              variant="ghost"
              color="neutral"
              data-testid="approval-mode-cancel-allow-all"
              onClick={() => {
                close()
                focusChip()
              }}
            >
              Cancel
            </Button>
            <Button
              ref={confirmRef}
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
