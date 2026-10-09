import { type ComponentProps, useCallback, useState } from 'react'
import type { ActiveSandboxUiApp } from '@/uiTypes'
import { SandboxUiPage } from '../../SandboxUiPage'

type LaunchingSandboxUiPageProps = Omit<ComponentProps<typeof SandboxUiPage>, 'onLaunchApp'> & {
  onLaunchApp?: (app: ActiveSandboxUiApp) => void
}

// The picker grid never opens an app itself: it hands it to the owner, and App
// (`launchSandboxUiApp`) feeds it back as `shortcutApp` with a fresh
// `shortcutOpenRequestId`. Page-level tests that need a mounted app reproduce
// exactly that round-trip here; the App-level ownership suite covers the real
// owner end to end. The title-bar container is document.body so the portaled
// mounted-app actions stay queryable via `screen`.
export function LaunchingSandboxUiPage({ onLaunchApp, ...props }: LaunchingSandboxUiPageProps) {
  const [launched, setLaunched] = useState<{ app: ActiveSandboxUiApp; requestId: number } | null>(
    null
  )
  const handleLaunchApp = useCallback(
    (app: ActiveSandboxUiApp) => {
      onLaunchApp?.(app)
      setLaunched(current => ({ app, requestId: (current?.requestId ?? 0) + 1 }))
    },
    [onLaunchApp]
  )
  return (
    <SandboxUiPage
      titlebarLeadingContainer={document.body}
      {...props}
      {...(launched
        ? { shortcutApp: launched.app, shortcutOpenRequestId: launched.requestId }
        : {})}
      onLaunchApp={handleLaunchApp}
    />
  )
}
