'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isPublisherEnabled, usePublishScope } from '../../lib/hooks/usePublishScope'
import packageJson from '../../package.json'
import { IconChevronRight } from '../icons'
import { activeSidebarChildHref } from './activeChild'
import { SIDEBAR_TABS } from './constants'
import { IconLogout } from './icons'
import type { SidebarItem, SidebarProps, SidebarTab } from './types'

export function Sidebar({ currentTab, isOpen = false, onNavigate, onLogout }: SidebarProps) {
  const pathname = usePathname()
  const { scope, loading: publishScopeLoading } = usePublishScope()
  const publisherEnabled = isPublisherEnabled(scope)
  const [expandedGroups, setExpandedGroups] = useState<Set<SidebarTab>>(
    () => new Set(SIDEBAR_TABS[currentTab].children?.length ? [currentTab] : [])
  )
  const entries = (Object.entries(SIDEBAR_TABS) as Array<[SidebarTab, SidebarItem]>)
    .filter(
      ([tabKey, item]) =>
        !item.hidden &&
        tabKey !== 'settings' &&
        (tabKey !== 'publisher' || publisherEnabled || publishScopeLoading)
    )
    .sort(([, first], [, second]) => first.label.localeCompare(second.label))
  const settings = SIDEBAR_TABS.settings

  function toggleGroup(tabKey: SidebarTab) {
    setExpandedGroups(current => {
      const next = new Set(current)
      if (next.has(tabKey)) next.delete(tabKey)
      else next.add(tabKey)
      return next
    })
  }

  return (
    <aside
      className={`cu-sidebar${isOpen ? ' cu-sidebar--open' : ''}`}
      aria-label="Main navigation"
    >
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
        {entries.map(([tabKey, item]) => {
          if (tabKey === 'publisher' && publishScopeLoading) {
            return (
              <div
                key={tabKey}
                className="cu-sidebar__item cu-sidebar__item--loading"
                aria-hidden="true"
              >
                <span className="cu-sidebar__icon cu-skeleton" />
                <span className="cu-sidebar__label cu-skeleton" />
              </div>
            )
          }
          const active = currentTab === tabKey
          const expanded = expandedGroups.has(tabKey)
          if (item.children?.length) {
            const activeChildHref = activeSidebarChildHref(pathname, item.children)
            return (
              <div key={tabKey} className="cu-sidebar__group">
                <button
                  type="button"
                  className="cu-sidebar__item cu-sidebar__item--expandable"
                  data-active={active ? 'true' : 'false'}
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(tabKey)}
                >
                  <span className="cu-sidebar__icon">{item.icon}</span>
                  <span className="cu-sidebar__label">{item.label}</span>
                  <IconChevronRight
                    className={expanded ? 'is-expanded' : undefined}
                    width={16}
                    height={16}
                  />
                </button>
                {expanded ? (
                  <div className="cu-sidebar__subnav">
                    {item.children.map(child => {
                      const childActive = child.href === activeChildHref
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className="cu-sidebar__subitem"
                          data-active={childActive ? 'true' : 'false'}
                          aria-current={childActive ? 'page' : undefined}
                          onClick={onNavigate}
                        >
                          <span className="cu-sidebar__subitem-icon" aria-hidden="true">
                            {child.icon}
                          </span>
                          <span>{child.label}</span>
                        </Link>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          }
          return (
            <Link
              key={tabKey}
              href={item.href}
              className="cu-sidebar__item"
              data-active={active ? 'true' : 'false'}
              aria-current={active ? 'page' : undefined}
              onClick={onNavigate}
            >
              <span className="cu-sidebar__icon">{item.icon}</span>
              <span className="cu-sidebar__label">
                <span>{item.label}</span>
              </span>
            </Link>
          )
        })}
      </nav>
      <div className="cu-sidebar__footer">
        <Link
          href={settings.href}
          className="cu-sidebar__item cu-sidebar__item--utility"
          data-active={currentTab === 'settings' ? 'true' : 'false'}
          onClick={onNavigate}
        >
          <span className="cu-sidebar__icon">{settings.icon}</span>
          <span className="cu-sidebar__label">Settings</span>
        </Link>
        {onLogout ? (
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
        ) : null}
      </div>
    </aside>
  )
}
