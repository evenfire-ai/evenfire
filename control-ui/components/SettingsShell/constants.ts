import type { TabBarOption } from '@components/TabBar/types'
import { CONTROL_ROUTES } from '@constants/routes'
import type { SettingsSection } from './types'

export const SETTINGS_TABS: TabBarOption<SettingsSection>[] = [
  { value: 'ui', href: CONTROL_ROUTES.settings.ui, label: 'UI' },
  { value: 'account', href: CONTROL_ROUTES.settings.account, label: 'Account' },
  {
    value: 'integrations',
    href: CONTROL_ROUTES.settings.integrations,
    label: 'Integrations',
  },
]
