import type { ThemeMode } from '@/uiTypes'

export const THEME_STORAGE_KEY = 'evenfire.ui.theme'

export const THEME_MODE_OPTIONS: ReadonlyArray<{
  value: ThemeMode
  label: string
  description: string
}> = [
  {
    value: 'dark',
    label: 'Dark',
    description: 'Use the darker interface across the desktop app.',
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Use the lighter interface across the desktop app.',
  },
]
