'use client'

import { createContext, useContext, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { MobileHeader } from '@components/MobileHeader'
import { Sidebar } from '@components/Sidebar'
import { PROFILE_ROUTES } from '@constants/routes'
import { profileRouteForPathname } from '@lib/profileAppFrame'
import type { ProfileShellProps } from './types'

const ProfileShellContext = createContext(false)

export function ProfileShell({ children }: ProfileShellProps) {
  const isInsideProfileShell = useContext(ProfileShellContext)
  if (isInsideProfileShell) return <>{children}</>

  return <PersistentProfileShell>{children}</PersistentProfileShell>
}

function PersistentProfileShell({ children }: ProfileShellProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const currentRoute = profileRouteForPathname(pathname)

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
      <main className="cu-main">
        <ProfileShellContext.Provider value>{children}</ProfileShellContext.Provider>
      </main>
    </div>
  )
}
