'use client'

import type { ReactNode } from 'react'
import { Button } from '@components/Button'
import { ReleaseLabel } from '@components/ReleaseLabel'
import { IconRefresh } from '@components/icons'

type SettingsPageHeaderProps = {
  disabled?: boolean
  spinning?: boolean
  refreshAriaLabel: string
  onRefresh: () => void
  actions?: ReactNode
}

export function SettingsPageHeader({
  disabled = false,
  spinning = false,
  refreshAriaLabel,
  onRefresh,
  actions,
}: SettingsPageHeaderProps) {
  return (
    <header className="header-row">
      <div>
        <h1 className="page-title">Settings</h1>
        <ReleaseLabel className="small-plus muted" />
      </div>
      <div className="toolbar">
        <Button
          variant="secondary"
          className="cu-btn--icon cu-btn--toolbar"
          onClick={onRefresh}
          disabled={disabled}
          aria-label={refreshAriaLabel}
        >
          <IconRefresh className={spinning ? 'cu-spin' : undefined} />
        </Button>
        {actions}
      </div>
    </header>
  )
}
