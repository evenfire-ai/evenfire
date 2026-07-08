'use client'

import React, { useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from './AuthContext'
import { Sidebar } from './Sidebar'
import type { SidebarTab } from './Sidebar/types'

interface DashboardLayoutProps {
  children: React.ReactNode
  isDetailPage?: boolean
}

export function DashboardLayout({ children, isDetailPage = false }: DashboardLayoutProps) {
  const pathname = usePathname()
  const { logout } = useAuth()

  const currentTab = useMemo<SidebarTab>(() => {
    if (pathname === '/hosts' || pathname.startsWith('/hosts/')) {
      return 'hosts'
    }
    if (pathname === '/contexts' || pathname.startsWith('/contexts/')) {
      return 'contexts'
    }
    if (pathname === '/profile-admin' || pathname.startsWith('/profile-admin/')) {
      return 'profile-admin'
    }
    if (
      pathname === '/workflow-recipes' ||
      pathname.startsWith('/workflow-recipes/') ||
      pathname === '/plugin-workload-sdk' ||
      pathname.startsWith('/plugin-workload-sdk/')
    ) {
      return 'workflow-recipes'
    }
    if (pathname === '/outputs' || pathname.startsWith('/outputs/')) {
      return 'outputs'
    }
    if (pathname === '/mcp-servers' || pathname.startsWith('/mcp-servers/')) {
      return 'mcp-servers'
    }
    if (pathname === '/shared-filesystems' || pathname.startsWith('/shared-filesystems/')) {
      return 'shared-filesystems'
    }
    if (pathname === '/gfs' || pathname.startsWith('/gfs/')) {
      return 'gfs'
    }
    if (pathname === '/communication-channels' || pathname.startsWith('/communication-channels/')) {
      return 'communication-channels'
    }
    if (pathname === '/secrets' || pathname.startsWith('/secrets/')) {
      return 'llm-secrets'
    }
    if (pathname === '/registry' || pathname.startsWith('/registry/')) {
      return 'registry-catalog'
    }
    if (pathname === '/publisher' || pathname.startsWith('/publisher/')) {
      return 'publisher'
    }
    if (pathname === '/cost' || pathname.startsWith('/cost/')) {
      return 'cost'
    }
    if (pathname.startsWith('/control-admins/')) {
      return 'profile-admin'
    }
    if (pathname === '/settings' || pathname.startsWith('/settings/')) {
      return 'settings'
    }
    return 'hosts'
  }, [pathname])

  function handleLogout() {
    void logout()
  }

  return (
    <div className="cu-app-layout">
      <Sidebar currentTab={currentTab} onLogout={handleLogout} />
      <main className={isDetailPage ? 'cu-main cu-detail-layout' : 'cu-main'}>{children}</main>
    </div>
  )
}
