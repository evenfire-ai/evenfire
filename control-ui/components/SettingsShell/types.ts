import type { ReactNode } from 'react'

export type SettingsSection = 'ui' | 'account' | 'integrations'

export type SettingsShellProps = {
  activeSection: SettingsSection
  children: ReactNode
}
