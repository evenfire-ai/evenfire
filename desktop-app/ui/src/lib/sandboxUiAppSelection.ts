import type {
  SandboxUiAppListing,
  SandboxUiDeepLinkAppResolution,
} from '@lib/sandboxUiAppSelection.types'
import type { ActiveSandboxUiApp } from '@/uiTypes'

function toActiveSandboxUiApp(app: SandboxUiAppListing): ActiveSandboxUiApp {
  return {
    appRef: app.appRef,
    label: app.title?.trim() || app.appRef,
    icon: app.icon,
    defaultPath: app.defaultPath,
  }
}

export function toActiveSandboxUiApps(apps: SandboxUiAppListing[]): ActiveSandboxUiApp[] {
  return apps.filter(app => app.ready).map(toActiveSandboxUiApp)
}

export function canProcessSandboxUiDeepLinks(
  booting: boolean,
  isAuthenticated: boolean,
  pendingLinkCount: number
): boolean {
  return !booting && isAuthenticated && pendingLinkCount > 0
}

export function resolveSandboxUiDeepLinkApp(
  apps: SandboxUiAppListing[],
  appRef: string
): SandboxUiDeepLinkAppResolution {
  const match = apps.find(app => app.appRef === appRef)
  if (!match) return { status: 'unavailable' }
  if (!match.ready) {
    return {
      status: 'starting',
      label: match.title?.trim() || match.appRef,
      phase: match.phase ?? null,
    }
  }
  return { status: 'ready', app: toActiveSandboxUiApp(match) }
}
