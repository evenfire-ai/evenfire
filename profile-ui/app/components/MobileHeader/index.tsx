'use client'

import Image from 'next/image'
import Link from 'next/link'
import { IconLogout, IconMenu, IconSettings } from '@components/Sidebar/icons'
import { PROFILE_ROUTES } from '@constants/routes'
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
        <IconMenu />
      </button>
      <Link
        href={PROFILE_ROUTES.home}
        className="cu-mobile-header__brand"
        aria-label="Evenfire home"
      >
        <Image src="/brand/logo.svg" alt="" width={30} height={30} aria-hidden="true" />
        <span>Evenfire</span>
      </Link>
      <div className="cu-mobile-header__utilities">
        <Link
          href={PROFILE_ROUTES.settings.profile}
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
