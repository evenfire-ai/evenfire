import { useState } from 'react'
import type { PermissionStatusIndicatorProps } from './types'

/** A fixed-size, opt-in progress affordance for an already-running permission query. */
export function PermissionStatusIndicator({
  label,
  active,
  className = '',
  children,
  announce = true,
}: PermissionStatusIndicatorProps) {
  const [retainedForFocus, setRetainedForFocus] = useState(false)
  const showIndicator = active || retainedForFocus
  const statusLabel = active ? label : 'Permission check complete'

  return (
    <span className={`da-permission-status-slot ${className}`.trim()}>
      {showIndicator ? (
        <span
          aria-hidden={announce ? undefined : true}
          aria-label={announce ? statusLabel : undefined}
          aria-live={active && announce ? 'polite' : 'off'}
          className="da-permission-status-indicator"
          role={active ? 'status' : 'group'}
          tabIndex={active && announce ? 0 : -1}
          title={statusLabel}
          onBlur={() => setRetainedForFocus(false)}
          onFocus={() => {
            if (active && announce) setRetainedForFocus(true)
          }}
        >
          {active ? (
            <span aria-hidden="true" className="da-permission-status-spinner" />
          ) : (
            <span aria-hidden="true" className="da-permission-status-complete">
              ✓
            </span>
          )}
          <span className="da-permission-status-tooltip">{statusLabel}</span>
        </span>
      ) : null}
      {children}
    </span>
  )
}
