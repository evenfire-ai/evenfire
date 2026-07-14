'use client'

import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { Sidebar } from '@components/Sidebar'
import type { ProfileShellProps } from './types'

export function ProfileShell({ currentRoute, children }: ProfileShellProps) {
  const router = useRouter()
  const { logout } = useAuth()

  function handleLogout() {
    logout()
    router.replace('/')
  }

  return (
    <div className="cu-app-layout">
      <Sidebar currentRoute={currentRoute} onLogout={handleLogout} />
      <main className="cu-main">{children}</main>
    </div>
  )
}
