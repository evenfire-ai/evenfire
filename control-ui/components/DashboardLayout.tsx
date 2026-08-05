'use client'

import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import { usePathname } from 'next/navigation'
import { CONTROL_ROUTES, isControlRouteSection } from '@constants/routes'
import { useAuth } from './AuthContext'
import { MobileHeader } from './MobileHeader'
import { Sidebar } from './Sidebar'
import type { SidebarTab } from './Sidebar/types'

interface DashboardLayoutProps {
  children: React.ReactNode
  isDetailPage?: boolean
}

type DashboardFrameContextValue = {
  setDetailPage: (isDetailPage: boolean) => void
}

const DashboardFrameContext = createContext<DashboardFrameContextValue | null>(null)

export function DashboardLayout({ children, isDetailPage = false }: DashboardLayoutProps) {
  const frame = useContext(DashboardFrameContext)

  if (frame) {
    return (
      <NestedDashboardContent isDetailPage={isDetailPage} setDetailPage={frame.setDetailPage}>
        {children}
      </NestedDashboardContent>
    )
  }

  return <PersistentDashboardFrame>{children}</PersistentDashboardFrame>
}

function NestedDashboardContent({
  children,
  isDetailPage,
  setDetailPage,
}: DashboardLayoutProps & DashboardFrameContextValue) {
  useLayoutEffect(() => {
    setDetailPage(isDetailPage)
    return () => setDetailPage(false)
  }, [isDetailPage, setDetailPage])

  return <>{children}</>
}

function PersistentDashboardFrame({ children }: Pick<DashboardLayoutProps, 'children'>) {
  const pathname = usePathname()
  const { logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const [isDetailPage, setIsDetailPage] = useState(false)

  const setDetailPage = useCallback((nextIsDetailPage: boolean) => {
    setIsDetailPage(nextIsDetailPage)
  }, [])

  const frameValue = useMemo(() => ({ setDetailPage }), [setDetailPage])

  const currentTab = useMemo<SidebarTab>(() => {
    if (isControlRouteSection(pathname, CONTROL_ROUTES.agents.root)) {
      return 'hosts'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.contexts.root)) {
      return 'contexts'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.usersAndTeams.base)) {
      return 'profile-admin'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.plugins.root)) {
      return 'workflow-recipes'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.agentOutputs.base)) {
      return 'directories'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.connectors.root)) {
      return 'mcp-servers'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.agentFiles.root)) {
      return 'directories'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.globalFileSystem)) {
      return 'directories'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.externalChannels.root)) {
      return 'communication-channels'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.secrets.root)) {
      return 'llm-secrets'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.marketplace.root)) {
      return 'registry-catalog'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.llmModels.root)) {
      return 'llm-models'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.costAndUsage.base)) {
      return 'cost'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.traces.root)) {
      return 'traces'
    }
    if (isControlRouteSection(pathname, CONTROL_ROUTES.settings.root)) {
      return 'settings'
    }
    return 'hosts'
  }, [pathname])

  function handleLogout() {
    void logout()
  }

  return (
    <div className="cu-app-layout">
      <MobileHeader
        menuOpen={menuOpen}
        onMenuToggle={() => setMenuOpen(open => !open)}
        onLogout={handleLogout}
      />
      <Sidebar
        currentTab={currentTab}
        isOpen={menuOpen}
        onNavigate={() => setMenuOpen(false)}
        onLogout={handleLogout}
      />
      <main className={`cu-main${isDetailPage ? ' cu-detail-layout' : ''}`}>
        <DashboardFrameContext.Provider value={frameValue}>
          {children}
        </DashboardFrameContext.Provider>
      </main>
    </div>
  )
}
