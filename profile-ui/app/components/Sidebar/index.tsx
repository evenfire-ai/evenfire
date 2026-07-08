'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useAuth } from '@components/AuthContext'
import { getManageableTeams, isSilentApiError } from '@lib/api'
import { listApprovalChannelTargets } from '@lib/approvalChannels'
import packageJson from '../../../package.json'
import { PROFILE_SIDEBAR_ITEMS } from './constants'
import { IconLogout } from './icons'
import type { ProfileRouteKey, ProfileSidebarItem, SidebarProps } from './types'

const MEMBER_ROUTE_ACCESS_CACHE_PREFIX = 'profile-ui.member-route-access.'
const APPROVAL_CHANNEL_ACCESS_CACHE_PREFIX = 'profile-ui.approval-channel-access.'

function memberRouteAccessCacheKey(userId: string): string {
  return `${MEMBER_ROUTE_ACCESS_CACHE_PREFIX}${userId}`
}

function approvalChannelAccessCacheKey(userId: string): string {
  return `${APPROVAL_CHANNEL_ACCESS_CACHE_PREFIX}${userId}`
}

function readCachedBoolean(key: string): boolean | null {
  if (!key || typeof window === 'undefined') return null
  try {
    const value = window.sessionStorage.getItem(key)
    if (value === 'true') return true
    if (value === 'false') return false
  } catch {
    return null
  }
  return null
}

function readCachedMemberRouteAccess(userId: string): boolean | null {
  if (!userId) return null
  return readCachedBoolean(memberRouteAccessCacheKey(userId))
}

function readCachedApprovalChannelAccess(userId: string): boolean | null {
  if (!userId) return null
  return readCachedBoolean(approvalChannelAccessCacheKey(userId))
}

function writeCachedBoolean(key: string, allowed: boolean): void {
  if (!key || typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(key, String(allowed))
  } catch {
    // Ignore private-mode or storage quota failures; the API result still drives this render.
  }
}

function writeCachedMemberRouteAccess(userId: string, allowed: boolean): void {
  if (!userId) return
  writeCachedBoolean(memberRouteAccessCacheKey(userId), allowed)
}

function writeCachedApprovalChannelAccess(userId: string, allowed: boolean): void {
  if (!userId) return
  writeCachedBoolean(approvalChannelAccessCacheKey(userId), allowed)
}

export function Sidebar({ currentRoute, onLogout }: SidebarProps) {
  const { authState } = useAuth()
  const userId = authState.me?.id || ''
  const activeRoleCanManage = authState.me?.role === 'admin' || authState.me?.role === 'inviter'
  const [hasManageableTeams, setHasManageableTeams] = useState(
    () => readCachedMemberRouteAccess(userId) ?? false
  )
  const [hasExternalChannelAccess, setHasExternalChannelAccess] = useState(
    () => readCachedApprovalChannelAccess(userId) ?? false
  )
  const canManageMembers = activeRoleCanManage || hasManageableTeams

  useEffect(() => {
    let cancelled = false
    if (!authState.isLoggedIn || !userId) {
      setHasManageableTeams(false)
      return
    }

    const cachedAccess = readCachedMemberRouteAccess(userId)
    if (cachedAccess !== null) {
      setHasManageableTeams(cachedAccess)
    } else {
      setHasManageableTeams(false)
    }

    if (activeRoleCanManage) {
      writeCachedMemberRouteAccess(userId, true)
      setHasManageableTeams(true)
      return
    }

    void getManageableTeams()
      .then(response => {
        if (cancelled) return
        const allowed = Boolean(response.items?.length)
        writeCachedMemberRouteAccess(userId, allowed)
        setHasManageableTeams(allowed)
      })
      .catch(error => {
        if (!cancelled && !isSilentApiError(error)) {
          writeCachedMemberRouteAccess(userId, false)
          setHasManageableTeams(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeRoleCanManage, authState.isLoggedIn, userId])

  useEffect(() => {
    let cancelled = false
    if (!authState.isLoggedIn || !userId) {
      setHasExternalChannelAccess(false)
      return
    }
    const cachedAccess = readCachedApprovalChannelAccess(userId)
    if (cachedAccess !== null) {
      setHasExternalChannelAccess(cachedAccess)
    }
    void listApprovalChannelTargets()
      .then(items => {
        if (!cancelled) {
          const allowed = items.length > 0
          writeCachedApprovalChannelAccess(userId, allowed)
          setHasExternalChannelAccess(allowed)
        }
      })
      .catch(error => {
        if (!cancelled && !isSilentApiError(error)) {
          if (cachedAccess === true) return
          writeCachedApprovalChannelAccess(userId, false)
          setHasExternalChannelAccess(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [authState.isLoggedIn, userId])

  return (
    <aside className="cu-sidebar" aria-label="Main navigation">
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
        {(Object.entries(PROFILE_SIDEBAR_ITEMS) as Array<[ProfileRouteKey, ProfileSidebarItem]>)
          .filter(
            ([routeKey]) =>
              (routeKey !== 'members' || canManageMembers) &&
              (routeKey !== 'approvalChannels' || hasExternalChannelAccess)
          )
          .map(([routeKey, item]) => (
            <Link
              key={routeKey}
              href={item.href}
              className="cu-sidebar__item"
              data-active={currentRoute === routeKey ? 'true' : 'false'}
              aria-current={currentRoute === routeKey ? 'page' : undefined}
            >
              <span className="cu-sidebar__icon">{item.icon}</span>
              <span className="cu-sidebar__label">{item.label}</span>
            </Link>
          ))}
      </nav>
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
    </aside>
  )
}
