'use client'

import Image from 'next/image'
import Link from 'next/link'
import { isPublisherEnabled, usePublishScope } from '../../lib/hooks/usePublishScope'
import packageJson from '../../package.json'
import { SIDEBAR_TABS } from './constants'
import { IconLogout } from './icons'
import type { SidebarItem, SidebarProps, SidebarTab } from './types'

export function Sidebar({ currentTab, onLogout }: SidebarProps) {
  const { scope } = usePublishScope()
  const publisherEnabled = isPublisherEnabled(scope)
  const entries = (Object.entries(SIDEBAR_TABS) as Array<[SidebarTab, SidebarItem]>).filter(
    ([tabKey]) => tabKey !== 'publisher' || publisherEnabled
  )

  return (
    <aside className="cu-sidebar" aria-label="Main navigation">
      <div className="cu-sidebar__brand" title={`Version ${packageJson.version}`}>
        <Image
          className="cu-sidebar__brand-mark cu-sidebar__brand-mark--light"
          src="/brand/logotype-light.svg"
          alt=""
          width={184}
          height={44}
          aria-hidden="true"
        />
        <Image
          className="cu-sidebar__brand-mark cu-sidebar__brand-mark--dark"
          src="/brand/logotype-dark.svg"
          alt="Evenfire"
          width={184}
          height={44}
        />
      </div>
      <nav className="cu-sidebar__nav" aria-label="Main sections">
        {entries.map(([tabKey, { href, label, icon }]) => (
          <Link
            key={tabKey}
            href={href}
            className="cu-sidebar__item"
            data-active={currentTab === tabKey ? 'true' : 'false'}
            aria-current={currentTab === tabKey ? 'page' : undefined}
          >
            <span className="cu-sidebar__icon">{icon}</span>
            <span className="cu-sidebar__label">
              <span>{label}</span>
            </span>
          </Link>
        ))}
      </nav>
      {onLogout && (
        <div className="cu-sidebar__footer">
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
      )}
    </aside>
  )
}
