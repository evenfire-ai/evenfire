type PermissionStatusIndicatorProps = {
  active: boolean
  label: string
}

export function PermissionStatusIndicator({ active, label }: PermissionStatusIndicatorProps) {
  return (
    <span className="da-permission-status-slot">
      {active ? (
        <span role="status" aria-label={label} className="da-permission-status-indicator">
          <span aria-hidden="true" className="da-permission-status-spinner" />
          <span className="visually-hidden">{label}</span>
        </span>
      ) : null}
    </span>
  )
}
