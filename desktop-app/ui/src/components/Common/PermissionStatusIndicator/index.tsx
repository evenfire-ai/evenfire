import type { PermissionStatusIndicatorProps } from './types'

/** A fixed-size, opt-in progress affordance for an already-running permission query. */
export function PermissionStatusIndicator({
  label,
  active,
  className = '',
  children,
  announce = true,
}: PermissionStatusIndicatorProps) {
  return (
    <span className={`da-permission-status-slot ${className}`.trim()}>
      {active ? (
        <span
          aria-hidden={announce ? undefined : true}
          aria-label={announce ? label : undefined}
          className="da-permission-status-indicator"
          role="status"
          tabIndex={announce ? 0 : -1}
          title={label}
        >
          <span aria-hidden="true" className="da-permission-status-spinner" />
          <span className="da-permission-status-tooltip">{label}</span>
        </span>
      ) : null}
      {children}
    </span>
  )
}
