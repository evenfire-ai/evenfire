import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@components/Common'
import type { PluginConsentModalProps } from './types'

/**
 * The plugin's live rectangle in the renderer is the `.sandbox-ui-embed-slot`
 * div that the native WebContentsView floats above (see SandboxUiPage). While
 * this prompt is up the native view is hidden, but the slot stays laid out — so
 * it is the correct box to center the prompt over, rather than the whole
 * desktop window. Returns null when no plugin embed is mounted, which lets the
 * prompt fall back to full-window centering.
 */
function readEmbedSlotRect(): DOMRect | null {
  const el = document.querySelector('.sandbox-ui-embed-slot')
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? rect : null
}

/**
 * The plugin permission prompt (spec §9.2, §9.4).
 *
 * Rendered by the TRUSTED renderer while the plugin's own `WebContentsView` is
 * hidden by the main process — a WebContentsView paints above renderer DOM
 * regardless of z-index, so hiding it is the only way to guarantee the plugin
 * can neither fake this modal nor paint over it.
 *
 * Every string here except `pluginTitle` comes from the host's own capability
 * catalog. The plugin cannot influence a single word of what the user reads,
 * and it cannot mark a row "required": that pressure belongs in the plugin's
 * own UI after a partial grant, where the user can see who is asking.
 *
 * Rows arrive pre-sorted most-sensitive-first and start checked; unchecking is
 * how a user grants part of a request.
 */
export function PluginConsentModal({ request, onResolve }: PluginConsentModalProps) {
  const titleId = useId()
  const allowButtonRef = useRef<HTMLButtonElement | null>(null)
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(request.rows.map(row => row.capability))
  )

  useEffect(() => {
    setChecked(new Set(request.rows.map(row => row.capability)))
  }, [request.promptId, request.rows])

  useEffect(() => {
    allowButtonRef.current?.focus()
  }, [request.promptId])

  // Track the plugin embed's rectangle so the prompt centers over the plugin
  // UI, not the entire desktop app. Re-measure on the same signals that move
  // the embed slot (resize, scroll, sidebar/layout shifts).
  const [slotRect, setSlotRect] = useState<DOMRect | null>(null)
  useLayoutEffect(() => {
    const measure = (): void => setSlotRect(readEmbedSlotRect())
    measure()
    const slot = document.querySelector('.sandbox-ui-embed-slot')
    const observer = slot ? new ResizeObserver(measure) : null
    if (slot) observer?.observe(slot)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [request.promptId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape denies everything — a prompt nobody answered is not consent.
      if (event.key === 'Escape') onResolve(request.promptId, [])
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onResolve, request.promptId])

  const toggle = (capability: string) => {
    setChecked(previous => {
      const next = new Set(previous)
      if (next.has(capability)) next.delete(capability)
      else next.add(capability)
      return next
    })
  }

  // Confine the fixed backdrop to the plugin's rectangle so `place-items:
  // center` centers the dialog over the plugin UI. Setting right/bottom to auto
  // overrides the stylesheet's `inset: 0`. No slot → undefined → full-window.
  const backdropStyle: CSSProperties | undefined = slotRect
    ? {
        top: slotRect.top,
        left: slotRect.left,
        width: slotRect.width,
        height: slotRect.height,
        right: 'auto',
        bottom: 'auto',
      }
    : undefined

  return createPortal(
    <div
      className="confirm-dialog-backdrop da-plugin-consent-backdrop"
      role="presentation"
      style={backdropStyle}
    >
      <div
        className="confirm-dialog da-plugin-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId}>{request.pluginTitle} wants access to your information</h3>

        {request.priorPromptCount > 0 ? (
          <p className="muted da-plugin-consent__count">
            This plugin has asked for permissions {request.priorPromptCount + 1} times this session.
          </p>
        ) : null}

        <ul className="da-plugin-consent__rows">
          {request.rows.map(row => (
            <li key={row.capability} className="da-plugin-consent__row">
              <label className="da-plugin-consent__label">
                <input
                  type="checkbox"
                  checked={checked.has(row.capability)}
                  onChange={() => toggle(row.capability)}
                />
                <span>
                  <span className="da-plugin-consent__row-title">{row.title}</span>
                  <span className="da-plugin-consent__row-detail muted">{row.dataDescription}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        <p className="muted da-plugin-consent__footer">
          You can change this any time in Settings → Plugin permissions.
        </p>

        <div className="confirm-dialog-actions">
          <Button
            color="neutral"
            onClick={() => onResolve(request.promptId, [])}
            size="sm"
            variant="ghost"
          >
            Deny
          </Button>
          <Button
            ref={allowButtonRef}
            color="primary"
            disabled={checked.size === 0}
            onClick={() => onResolve(request.promptId, [...checked])}
            size="sm"
          >
            Allow
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
