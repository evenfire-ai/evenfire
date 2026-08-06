'use client'

import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { SettingsDataProvider } from '@components/SettingsDataContext'
import { IconSettings } from '@components/Sidebar/icons'
import { TabBar } from '@components/TabBar'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { SETTINGS_TABS } from './constants'
import type { SettingsSection, SettingsShellProps } from './types'

export function SettingsShell({ activeSection, children }: SettingsShellProps) {
  return (
    <AuthGate>
      <DashboardLayout>
        <SettingsDataProvider>
          <div className="cu-card cu-card--viewport-fill cu-settings-card">
            <TablePanelHeader
              title={
                <>
                  <IconSettings />
                  Settings
                </>
              }
              subtitle="Manage the interface, account, and organization integrations."
            />
            <div className="cu-card__body">
              <TabBar<SettingsSection>
                activeValue={activeSection}
                ariaLabel="Settings sections"
                className="cu-tabs--flush"
                options={SETTINGS_TABS}
              />
              {children}
            </div>
          </div>
        </SettingsDataProvider>
      </DashboardLayout>
    </AuthGate>
  )
}
