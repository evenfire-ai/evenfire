import { IconButton } from '@components/Common'
import { type GfsResourceAction, getGfsToolbarActions } from '@lib/gfsResourceActions'

export function GfsResourceToolbar({
  actions,
  className,
}: {
  actions: GfsResourceAction[]
  className?: string
}) {
  const toolbarActions = getGfsToolbarActions(actions)
  if (toolbarActions.length === 0) return null
  return (
    <div
      aria-label="EvenDrive actions"
      className={`da-gfs-resource-toolbar${className ? ` ${className}` : ''}`}
      role="toolbar"
    >
      {toolbarActions.map(action => (
        <IconButton
          key={action.id}
          aria-busy={action.loading || undefined}
          className="da-gfs-resource-toolbar__button"
          data-gfs-action={action.id}
          disabled={action.disabled}
          label={action.label}
          loading={action.loading}
          onClick={() => action.run()}
          size="sm"
          variant="ghost"
        >
          {action.icon}
        </IconButton>
      ))}
    </div>
  )
}
