import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '@components/Common'
import { type GfsResourceAction, getGfsToolbarActions } from '@lib/gfsResourceActions'

export function GfsResourceToolbar({
  actions,
  className,
  portalTarget,
}: {
  actions: GfsResourceAction[]
  className?: string
  /** Render inside the active workspace navbar when supplied. */
  portalTarget?: HTMLElement | null
}) {
  const toolbarActions = getGfsToolbarActions(actions)
  const tooltipIdPrefix = useId()
  const [hoveredTooltipAction, setHoveredTooltipAction] = useState<string | null>(null)
  const [focusedTooltipAction, setFocusedTooltipAction] = useState<string | null>(null)
  if (toolbarActions.length === 0) return null

  const toolbar = (
    <div
      aria-label="EvenDrive actions"
      className={`window-titlebar__leading-actions da-gfs-resource-toolbar${className ? ` ${className}` : ''}`}
      role="toolbar"
    >
      {toolbarActions.map(action => {
        const tooltipId = `${tooltipIdPrefix}-${action.id}`
        const tooltipVisible =
          hoveredTooltipAction === action.id || focusedTooltipAction === action.id
        return (
          <span
            className="titlebar-leading-action da-gfs-resource-toolbar__item"
            key={action.id}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setFocusedTooltipAction(null)
              }
            }}
            onFocus={() => setFocusedTooltipAction(action.id)}
            onMouseEnter={() => setHoveredTooltipAction(action.id)}
            onMouseLeave={() => setHoveredTooltipAction(null)}
          >
            <IconButton
              aria-busy={action.loading || undefined}
              aria-describedby={tooltipVisible ? tooltipId : undefined}
              className="titlebar-leading-action__btn da-gfs-resource-toolbar__button"
              data-gfs-action={action.id}
              disabled={action.disabled}
              label={action.label}
              loading={action.loading}
              onClick={() => action.run()}
              size="sm"
              tooltip={false}
              variant="ghost"
            >
              {action.icon}
            </IconButton>
            {tooltipVisible ? (
              <span className="da-gfs-resource-toolbar__tooltip" id={tooltipId} role="tooltip">
                {action.label}
              </span>
            ) : null}
          </span>
        )
      })}
    </div>
  )

  if (portalTarget === undefined) return toolbar
  return portalTarget ? createPortal(toolbar, portalTarget) : null
}
