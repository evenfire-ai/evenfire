import { IconButton } from '@components/Common'
import { IconCopy, IconRefresh } from '@components/SidebarNav/icons'
import { joinClasses } from '@lib/classNames'

// Icon-only app action rendered into the native title bar's leading slot. The
// label is surfaced through IconButton's native `title` (from `label`) plus
// `aria-label` for assistive tech. The native `title` is deliberate here: the
// mounted app is a native WebContentsView that always paints above the renderer
// DOM regardless of CSS, so a DOM tooltip would render BEHIND the app view and
// be unreadable. The OS composes the native `title` tooltip over that native
// view, so it is the only label affordance that can actually be seen.
function TitlebarLeadingAction({
  className,
  label,
  pressed,
  onClick,
  children,
}: {
  className: string
  label: string
  pressed?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <span className="titlebar-leading-action">
      <IconButton
        variant="ghost"
        size="sm"
        className={joinClasses('titlebar-leading-action__btn', className)}
        label={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
      </IconButton>
    </span>
  )
}

export type SandboxUiTitlebarLeadingActionsProps = {
  onRefresh: () => void
  onCopyLink: () => void
}

export function SandboxUiTitlebarLeadingActions({
  onRefresh,
  onCopyLink,
}: SandboxUiTitlebarLeadingActionsProps) {
  return (
    <div className="window-titlebar__leading-actions">
      <TitlebarLeadingAction
        className="sandbox-ui-refresh-btn"
        label="Refresh app content"
        onClick={onRefresh}
      >
        <IconRefresh />
      </TitlebarLeadingAction>
      <TitlebarLeadingAction
        className="sandbox-ui-copy-link-btn"
        label="Copy current app link"
        onClick={onCopyLink}
      >
        <IconCopy />
      </TitlebarLeadingAction>
    </div>
  )
}
