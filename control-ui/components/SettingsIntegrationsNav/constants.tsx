import type { TabBarOption } from '@components/TabBar/types'
import { CONTROL_ROUTES } from '@constants/routes'
import type { SettingsIntegrationSection } from './types'

export const SETTINGS_INTEGRATION_TABS: TabBarOption<SettingsIntegrationSection>[] = [
  {
    value: 'microsoft',
    href: CONTROL_ROUTES.settings.microsoft,
    label: (
      <>
        <img src="/brand/microsoft-teams.svg" alt="" width={18} height={18} aria-hidden="true" />
        <span>Microsoft Teams</span>
      </>
    ),
  },
  {
    value: 'google',
    href: CONTROL_ROUTES.settings.google,
    label: (
      <>
        <img src="/brand/google.svg" alt="" width={18} height={18} aria-hidden="true" />
        <span>Google Workspace</span>
      </>
    ),
  },
]
