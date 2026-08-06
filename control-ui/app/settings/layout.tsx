'use client'

import type { ReactNode } from 'react'
import { useSelectedLayoutSegments } from 'next/navigation'
import { SettingsShell } from '@components/SettingsShell'
import type { SettingsSection } from '@components/SettingsShell/types'

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const segments = useSelectedLayoutSegments()

  if (segments[0] === 'integrations' && segments.length > 2) {
    return <>{children}</>
  }

  let activeSection: SettingsSection = 'ui'
  if (segments[0] === 'account') activeSection = 'account'
  if (segments[0] === 'integrations') activeSection = 'integrations'

  return <SettingsShell activeSection={activeSection}>{children}</SettingsShell>
}
