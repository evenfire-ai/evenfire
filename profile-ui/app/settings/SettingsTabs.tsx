'use client'

import Link from 'next/link'
import { useProfileAccess } from '@components/ProfileAccessContext'
import { PROFILE_ROUTES } from '@constants/routes'

export type SettingsTabKey = 'profile' | 'approvalChannels'

export function SettingsTabs({ active }: { active: SettingsTabKey }) {
  const { approvalTargets } = useProfileAccess()
  const hasApprovalAccess = approvalTargets.length > 0

  return (
    <div className="tabs" role="tablist" aria-label="Settings sections">
      <Link
        href={PROFILE_ROUTES.settings.profile}
        className={`tab-button${active === 'profile' ? ' is-active' : ''}`}
        role="tab"
        aria-selected={active === 'profile'}
      >
        Profile
      </Link>
      {hasApprovalAccess ? (
        <Link
          href={PROFILE_ROUTES.settings.approvalChannels}
          className={`tab-button${active === 'approvalChannels' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={active === 'approvalChannels'}
        >
          Approval channels
        </Link>
      ) : null}
    </div>
  )
}
