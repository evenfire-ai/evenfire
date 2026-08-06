import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@components/Common'
import type { PluginConsentModalProps } from './types'

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

  return createPortal(
    <div className="confirm-dialog-backdrop da-plugin-consent-backdrop" role="presentation">
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
