import type { PowerMonitor } from 'electron'
import type { AppService } from './appService.js'

type MemoryOnlySessionLifecycle = Pick<
  AppService,
  'endMemoryOnlySessionForSystemSuspend' | 'checkTemporarySessionExpiry'
>

/** Bind the temporary-session expiry contract to Electron's system power events. */
export function wireMemoryOnlySessionPowerLifecycle(
  powerMonitor: Pick<PowerMonitor, 'on'>,
  appService: MemoryOnlySessionLifecycle,
  emitSystemResume: () => void
): void {
  powerMonitor.on('suspend', () => appService.endMemoryOnlySessionForSystemSuspend())
  const resume = () => {
    appService.checkTemporarySessionExpiry()
    emitSystemResume()
  }
  powerMonitor.on('resume', resume)
  powerMonitor.on('unlock-screen', resume)
}
