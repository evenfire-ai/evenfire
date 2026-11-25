import { forwardRef } from 'react'
import { IconButton } from '@components/Common'

export type CompactNavigationToggleProps = {
  expanded: boolean
  onClick?: () => void
}

export const CompactNavigationToggle = forwardRef<HTMLButtonElement, CompactNavigationToggleProps>(
  function CompactNavigationToggle({ expanded, onClick }, ref) {
    return (
      <IconButton
        ref={ref}
        className="compact-navigation-toggle"
        data-testid="compact-navigation-toggle"
        label="Open navigation"
        aria-controls="desktop-sidebar-navigation"
        aria-expanded={expanded}
        onClick={onClick}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h12" />
        </svg>
      </IconButton>
    )
  }
)
