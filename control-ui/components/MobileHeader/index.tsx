'use client'

import Image from 'next/image'
import Link from 'next/link'
import { IconLogout, IconSettings } from '@components/Sidebar/icons'
import { IconMenu } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import type { MobileHeaderProps } from './types'

export function MobileHeader({ menuOpen, onLogout, onMenuToggle }: MobileHeaderProps) {
  return (
    <header className="cu-mobile-header">
      <button
        type="button"
        className="cu-mobile-header__action"
        onClick={onMenuToggle}
        aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={menuOpen}
      >
        <IconMenu width={20} height={20} />
      </button>
      <Link
        href={CONTROL_ROUTES.agents.root}
        className="cu-mobile-header__brand"
        aria-label="Evenfire home"
      >
        <Image src="/brand/logo.svg" alt="" width={30} height={30} aria-hidden="true" />
        <span>Evenfire</span>
      </Link>
      <div className="cu-mobile-header__utilities">
        <Link
          href={CONTROL_ROUTES.settings.ui}
          className="cu-mobile-header__action"
          aria-label="Settings"
        >
          <IconSettings />
        </Link>
        <button
          type="button"
          className="cu-mobile-header__action"
          onClick={onLogout}
          aria-label="Log out"
        >
          <IconLogout />
        </button>
      </div>
    </header>
  )
}
