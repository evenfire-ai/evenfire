'use client'

import { TabBar } from '@components/TabBar'
import { SETTINGS_INTEGRATION_TABS } from './constants'
import type { SettingsIntegrationSection, SettingsIntegrationsNavProps } from './types'

export function SettingsIntegrationsNav({ activeSection }: SettingsIntegrationsNavProps) {
  return (
    <TabBar<SettingsIntegrationSection>
      activeValue={activeSection}
      ariaLabel="Organization integrations"
      className="cu-integrations-tabs cu-tabs--flush"
      options={SETTINGS_INTEGRATION_TABS}
    />
  )
}
