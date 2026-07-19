'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { MobileHeader } from '@components/MobileHeader'
import { Sidebar } from '@components/Sidebar'
import { PROFILE_ROUTES } from '@constants/routes'
import type { ProfileShellProps } from './types'

export function ProfileShell({ currentRoute, children }: ProfileShellProps) {
  const router = useRouter()
  const { logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)

  function handleLogout() {
    logout()
    router.replace(PROFILE_ROUTES.home)
  }

  return (
    <div className="cu-app-layout">
      <MobileHeader
        menuOpen={menuOpen}
        onMenuToggle={() => setMenuOpen(open => !open)}
        onLogout={handleLogout}
      />
      <Sidebar
        currentRoute={currentRoute}
        isOpen={menuOpen}
        onNavigate={() => setMenuOpen(false)}
        onLogout={handleLogout}
      />
      <main className="cu-main">{children}</main>
    </div>
  )
}
