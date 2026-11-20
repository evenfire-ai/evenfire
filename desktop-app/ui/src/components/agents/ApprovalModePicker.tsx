import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button, Pill } from '@components/Common'
import { useClickOutside } from '@hooks/useClickOutside'
import { useHostApprovalMode } from '@hooks/useHostApprovalMode'
import type { ApprovalMode, HostApprovalModeView } from '@lib/hostApprovalModeStore'

export interface ApprovalModePickerProps {
  agentRef: string
  chatId: string
}

const ALLOW_ALL_CONFIRM =
  'Allow all runs tools in this chat without asking, except scheduled tasks. Continue?'
const FIRST_SEND_LOCK_HINT = 'The approval mode can change once the first message reaches the Host.'
const SAVING_HINT = 'Saving the approval mode…'
const CLASSIFIER_NOTE = 'shell always asks on this model'
const WRITE_ERROR = 'The approval mode could not be saved.'

const MODE_OPTIONS: ReadonlyArray<{ mode: ApprovalMode; label: string; testId: string }> = [
  { mode: 'manual', label: 'Manual', testId: 'approval-mode-option-manual' },
  { mode: 'auto', label: 'Auto-approve', testId: 'approval-mode-option-auto' },
  { mode: 'allow_all', label: 'Allow all', testId: 'approval-mode-option-allow-all' },
]

const MODE_RANK: Record<ApprovalMode, number> = { manual: 0, auto: 1, allow_all: 2 }

function modeName(mode: ApprovalMode): string {
  return MODE_OPTIONS.find(option => option.mode === mode)?.label ?? 'Manual'
}

/**
 * The menu's note on the Host limit: what the chat was set to when the Host
 * runs less, or which modes the Host allows when some rows are not offered.
 */
function limitNote(view: HostApprovalModeView): string | null {
  if (view.storedMode !== view.effectiveMode) {
    return `Set to ${modeName(view.storedMode)}; this Host limits this chat to ${modeName(view.effectiveMode)}.`
  }
  if (view.modeLimit !== null && view.modeLimit !== 'allow_all') {
    return `This Host limits this chat to ${modeName(view.modeLimit)}.`
  }
  return null
}

function savedAnnouncement(view: HostApprovalModeView): string {
  if (view.storedMode !== view.effectiveMode) {
    return `Approval mode set to ${modeName(view.storedMode)}; this Host limits this chat to ${modeName(view.effectiveMode)}.`
  }
  return `Approval mode set to ${modeName(view.effectiveMode)}.`
}

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
 * One mode write is in flight per chat. While the chat's save is unanswered
 * the chip is busy (`aria-busy`, `aria-disabled`) and does not open, and the
 * store refuses a second pick, so two saves can never be answered out of
 * order. The chip stays focusable: a pick hands focus back to it just before
 * the save starts.
 *
 * Whether the chat's latest pick was not saved lives in the approval-mode
 * store, per chat, so the error follows the chat across switches and remounts.
 * Opening the menu again clears it.
 *
 * The chip shows the mode the Host runs. Modes above the Host's limit for the
 * chat stay in the menu but are not offered (`aria-disabled`, described by a
 * note that names the limit); when the chat is set above the limit, the note
 * says so. With no answer from the Host yet the limit is unknown and every
 * mode is offered. Opening the menu re-reads the limit, so rows follow an
 * admin's change. A saved pick is announced through a polite status region,
 * with the limit when the Host runs less than the pick.
 *
 * When the session's model cannot run the shell classifier and the mode is
 * auto, the chip turns warning-toned and says so in its tooltip and to screen
 * readers; the open menu says it too.
 */
export function ApprovalModePicker({ agentRef, chatId }: ApprovalModePickerProps) {
  const selectionChatId = chatId || null
  const approval = useHostApprovalMode(agentRef, selectionChatId)
  const {
    label,
    effectiveMode,
    modeLimit,
    shellClassifierAvailable,
    firstSendInFlight,
    writeInFlight,
    saveFailed,
    selectMode,
    clearSaveFailure,
    refreshLimit,
    readView,
  } = approval
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const classifierNoteId = useId()
  const confirmTextId = useId()
  const limitNoteId = useId()

  // The chip cannot open while the first send or a save for this chat is in flight.
  const locked = firstSendInFlight || writeInFlight

  // Reset during render, not in an effect: a passive effect would commit the
  // previous chat's menu under the next chat first, and could undo a click
  // that lands before it runs.
  const scopeKey = `${agentRef}::${selectionChatId ?? ''}`
  const [renderedFor, setRenderedFor] = useState({ scopeKey, locked })
  if (renderedFor.scopeKey !== scopeKey || renderedFor.locked !== locked) {
    if (renderedFor.scopeKey !== scopeKey || (locked && !renderedFor.locked)) {
      setOpen(false)
      setConfirming(false)
    }
    if (renderedFor.scopeKey !== scopeKey) setAnnouncement('')
    setRenderedFor({ scopeKey, locked })
  }
  // The chat on screen after the last commit, for a save that settles later.
  const shownScopeKey = useRef(scopeKey)
  useLayoutEffect(() => {
    shownScopeKey.current = scopeKey
  })

  const chipLabel = label ?? 'Manual'
  const showClassifierNote = effectiveMode === 'auto' && shellClassifierAvailable === false
  const menuOpen = open && !locked
  const limitNoteText = limitNote(approval)

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
    const pickedFor = scopeKey
    void selectMode(mode).then(saved => {
      // Announce a saved pick only while its chat is still on screen.
      if (saved && shownScopeKey.current === pickedFor) {
        setAnnouncement(savedAnnouncement(readView()))
      }
    })
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
        className={`model-selector-chip${locked ? ' model-selector-chip--disabled' : ''}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-disabled={locked || undefined}
        aria-busy={writeInFlight || undefined}
        aria-label={`Approval mode — ${chipLabel}`}
        aria-describedby={showClassifierNote ? classifierNoteId : undefined}
        data-testid="approval-mode-picker"
        title={
          firstSendInFlight
            ? FIRST_SEND_LOCK_HINT
            : writeInFlight
              ? SAVING_HINT
              : showClassifierNote
                ? `${chipLabel}: ${CLASSIFIER_NOTE}`
                : undefined
        }
        onClick={() => {
          if (locked) return
          if (!open) {
            clearSaveFailure()
            void refreshLimit()
          }
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

      {/* A polite live region, not role="status": the composer has its own status line. */}
      <span
        className="visually-hidden"
        aria-live="polite"
        aria-atomic="true"
        data-testid="approval-mode-status"
      >
        {announcement}
      </span>

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
          aria-describedby={confirmTextId}
          tabIndex={-1}
          onKeyDown={keepFocusInConfirmation}
        >
          <p id={confirmTextId} className="approval-mode-picker-confirm-text">
            {ALLOW_ALL_CONFIRM}
          </p>
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
              onClick={event => {
                // The confirmation opens where the menu was, and this button
                // sits under the right end of the "Allow all" row. The second
                // click of a double-click on that row lands here, so only a
                // single click or a key press (detail 0) confirms.
                if (event.detail > 1) return
                choose('allow_all')
              }}
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
          {limitNoteText ? (
            <p
              id={limitNoteId}
              className="model-selector-notice"
              data-testid="approval-mode-limit-note"
            >
              {limitNoteText}
            </p>
          ) : null}
          <ul className="model-selector-list">
            {MODE_OPTIONS.map(option => {
              const isActive = option.mode === effectiveMode
              // Above the Host's limit: shown, not offered. Unknown limit offers all.
              const aboveLimit = modeLimit !== null && MODE_RANK[option.mode] > MODE_RANK[modeLimit]
              return (
                <li key={option.mode}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    aria-disabled={aboveLimit || undefined}
                    aria-describedby={aboveLimit && limitNoteText ? limitNoteId : undefined}
                    data-testid={option.testId}
                    className={`model-selector-item${isActive ? ' model-selector-item--active' : ''}`}
                    onClick={() => {
                      if (aboveLimit) return
                      if (option.mode === 'allow_all') setConfirming(true)
                      else choose(option.mode)
                    }}
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
