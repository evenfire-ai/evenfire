import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HostModelOption } from '@hooks/useChatStore'
import { useClickOutside } from '@hooks/useClickOutside'
import { useHostModels } from '@hooks/useHostModels'
import { Pill } from '../Common'

export interface ModelSelectorProps {
  /** The agent IS the hostRef for desktop chats (mirrors ContextWindowIndicator). */
  agentRef: string
  chatId: string
  /**
   * Which way the popover expands. `'down'` (default) anchors it below the chip
   * for the top indicators row; `'up'` anchors it above the chip for the
   * composer, where the chip sits at the bottom of the window and a downward
   * menu would clip off-screen.
   */
  placement?: 'down' | 'up'
}

/** How long the "applies to your next message" confirmation badge stays up. */
const APPLIED_BADGE_MS = 4000

/** Human label for a model: operator `displayName` if set, else the raw name. */
function modelLabel(name: string, options: HostModelOption[]): string {
  const match = options.find(option => option.name === name)
  return match?.displayName?.trim() || name
}

/**
 * Per-session model selector for the chat indicators row (R2), sat next to the
 * agent title and context-window chip. Shows the effective model
 * (`sessionModel ?? hostDefault`) and, on click, a popover listing the allowed
 * models. Choosing one applies it to the NEXT task ("applies to your next
 * message" — R2.5).
 *
 * Visibility / degraded rules:
 *   - Hidden entirely until the model list loads, and when the host predates the
 *     endpoint or the fetch failed (`data` null/undefined) — no noisy error
 *     (R2.6).
 *   - `degraded` (allowlist ConfigMap unavailable, R3.5): the chip is disabled
 *     and shows only the host default with an explanatory tooltip.
 *   - `sessionModelBlocked` (R2.2): a warning notice tells the user their prior
 *     model fell out of the allowlist and the default is in use.
 *   - A `model_not_allowed` rejection (R2, 403): inline error, selection unchanged.
 */
export function ModelSelector({ agentRef, chatId, placement = 'down' }: ModelSelectorProps) {
  const { data, saving, error, selectModel, clearError } = useHostModels(agentRef, chatId)
  const [open, setOpen] = useState(false)
  const [applied, setApplied] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useClickOutside(containerRef, open, () => setOpen(false))

  // Reset transient popover UI when the chat/agent changes — the hook is mounted
  // un-keyed, so without this a lingering "applies to your next message" badge or
  // an open popover from the previous chat would carry over after a switch.
  useEffect(() => {
    setOpen(false)
    setApplied(false)
  }, [agentRef, chatId])

  // ESC closes the popover, matching AgentTitleSelector's keyboard UX.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  // Auto-dismiss the confirmation badge.
  useEffect(() => {
    if (!applied) return
    const timeoutId = window.setTimeout(() => setApplied(false), APPLIED_BADGE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [applied])

  const effectiveModel = data ? (data.sessionModel ?? data.hostDefault) : ''
  const effectiveLabel = useMemo(
    () => (data ? modelLabel(effectiveModel, data.models) : ''),
    [data, effectiveModel]
  )

  const handleSelect = useCallback(
    async (model: string) => {
      setOpen(false)
      if (model === effectiveModel) return
      const ok = await selectModel(model)
      if (ok) setApplied(true)
    },
    [effectiveModel, selectModel]
  )

  // Placement modifier: the composer anchors the chip at the bottom of the
  // window, so the popover must expand upward instead of downward.
  const rootClassName = `model-selector${placement === 'up' ? ' model-selector--up' : ''}`
  // Caret points toward where the menu will appear: for a downward menu it
  // points down when closed / up when open; for an upward menu it's inverted.
  const caretPointsUp = placement === 'up' ? !open : open
  const caretPath = caretPointsUp ? 'm4.5 10 3.5-3.5L11.5 10' : 'm4.5 6 3.5 3.5L11.5 6'

  // Hidden until we have a model list to show (undefined = loading first fetch,
  // null = unsupported host / failed fetch). No flashing empty chip.
  if (!data) return null

  // Degraded: the allowlist is unavailable, so only the host default is usable.
  // Render a static, non-interactive chip with an explanatory tooltip.
  if (data.degraded) {
    return (
      <div className={rootClassName}>
        <Pill
          tone="neutral"
          size="sm"
          className="model-selector-chip model-selector-chip--disabled"
          aria-label={`Model ${effectiveLabel} (selection unavailable)`}
          title="Model selection is unavailable right now — using the host default."
        >
          <span className="model-selector-chip-glyph" aria-hidden="true" />
          <span className="model-selector-chip-label">{effectiveLabel}</span>
        </Pill>
      </div>
    )
  }

  return (
    <div className={rootClassName} ref={containerRef}>
      <Pill
        tone={data.sessionModelBlocked ? 'warning' : 'neutral'}
        size="sm"
        interactive
        className="model-selector-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model — ${effectiveLabel}`}
        onClick={() => {
          clearError()
          setOpen(prev => !prev)
        }}
      >
        <span className="model-selector-chip-glyph" aria-hidden="true" />
        <span className="model-selector-chip-label">{effectiveLabel}</span>
        <svg
          className="model-selector-chip-caret"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path d={caretPath} />
        </svg>
      </Pill>

      {applied && (
        <span className="model-selector-applied" role="status" aria-live="polite">
          Applies to your next message
        </span>
      )}

      {open && (
        <div className="model-selector-popover" role="menu" aria-label="Select model">
          {data.sessionModelBlocked && (
            <p className="model-selector-notice model-selector-notice--warning">
              Your previous model <strong>{data.sessionModelBlocked}</strong> is no longer allowed —
              using the default.
            </p>
          )}
          {error && (
            <p className="model-selector-notice model-selector-notice--error" role="alert">
              {error}
            </p>
          )}
          {data.models.length ? (
            <ul className="model-selector-list">
              {data.models.map(option => {
                const isActive = option.name === effectiveModel
                return (
                  <li key={option.name}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      className={`model-selector-item${isActive ? ' model-selector-item--active' : ''}`}
                      disabled={saving}
                      onClick={() => void handleSelect(option.name)}
                    >
                      <span className="model-selector-item-label">
                        {option.displayName?.trim() || option.name}
                        {option.name === data.hostDefault && (
                          <span className="model-selector-item-tag">default</span>
                        )}
                      </span>
                      {isActive && (
                        <svg
                          className="model-selector-item-check"
                          viewBox="0 0 16 16"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <path d="m3.5 8.5 3 3 6-6" />
                        </svg>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="model-selector-notice">No models are available for this agent.</p>
          )}
        </div>
      )}
    </div>
  )
}
