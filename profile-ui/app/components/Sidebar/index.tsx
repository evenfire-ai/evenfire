'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useProfileAccess } from '@components/ProfileAccessContext'
import packageJson from '../../../package.json'
import { PROFILE_SIDEBAR_ITEMS } from './constants'
import { IconLogout } from './icons'
import type { ProfileRouteKey, ProfileSidebarItem, SidebarProps } from './types'

export function Sidebar({ currentRoute, isOpen = false, onNavigate, onLogout }: SidebarProps) {
  const { approvalTargets, approvalTargetsLoading, canManageMembers, manageableTeamsLoading } =
    useProfileAccess()
  const hasExternalChannelAccess = approvalTargets.length > 0

  const navigationItems = (
    Object.entries(PROFILE_SIDEBAR_ITEMS) as Array<[ProfileRouteKey, ProfileSidebarItem]>
  )
    .filter(([routeKey]) => routeKey !== 'settings')
    .sort(([, first], [, second]) => first.label.localeCompare(second.label))
  const settings = PROFILE_SIDEBAR_ITEMS.settings

  return (
    <aside
      className={`cu-sidebar${isOpen ? ' cu-sidebar--open' : ''}`}
      aria-label="Main navigation"
    >
      <div className="cu-sidebar__brand" title={`Version ${packageJson.version}`}>
        <Image
          className="cu-sidebar__brand-mark"
          src="/brand/logo.svg"
          alt=""
          width={44}
          height={44}
          aria-hidden="true"
        />
        <div className="cu-sidebar__brand-copy">
          <h1 className="cu-sidebar__title">Evenfire</h1>
          <p className="cu-sidebar__subtitle">Profile Portal</p>
        </div>
      </div>
      <nav className="cu-sidebar__nav" aria-label="Main sections">
        {navigationItems.map(([routeKey, item]) => {
          const accessLoading =
            (routeKey === 'members' && manageableTeamsLoading && !canManageMembers) ||
            (routeKey === 'approvalChannels' && approvalTargetsLoading && !hasExternalChannelAccess)
          const accessDenied =
            (routeKey === 'members' && !canManageMembers) ||
            (routeKey === 'approvalChannels' && !hasExternalChannelAccess)

          if (accessLoading) {
            return (
              <div
                key={routeKey}
                className="cu-sidebar__item cu-sidebar__item--loading"
                aria-hidden="true"
              >
                <span className="cu-sidebar__icon cu-skeleton" />
                <span className="cu-sidebar__label cu-skeleton" />
              </div>
            )
          }
          if (accessDenied) return null

          return (
            <Link
              key={routeKey}
              href={item.href}
              className="cu-sidebar__item"
              data-active={currentRoute === routeKey ? 'true' : 'false'}
              aria-current={currentRoute === routeKey ? 'page' : undefined}
              onClick={onNavigate}
            >
              <span className="cu-sidebar__icon">{item.icon}</span>
              <span className="cu-sidebar__label">{item.label}</span>
            </Link>
          )
        })}
      </nav>
      <div className="cu-sidebar__footer">
        <Link
          href={settings.href}
          className="cu-sidebar__item cu-sidebar__item--utility"
          data-active={currentRoute === 'settings' ? 'true' : 'false'}
          aria-current={currentRoute === 'settings' ? 'page' : undefined}
          onClick={onNavigate}
        >
          <span className="cu-sidebar__icon">{settings.icon}</span>
          <span className="cu-sidebar__label">Settings</span>
        </Link>
        <button
          type="button"
          className="cu-sidebar__item cu-sidebar__item--utility"
          onClick={onLogout}
        >
          <span className="cu-sidebar__icon">
            <IconLogout />
          </span>
          <span className="cu-sidebar__label">Log out</span>
        </button>
      </div>
    </aside>
  )
}
