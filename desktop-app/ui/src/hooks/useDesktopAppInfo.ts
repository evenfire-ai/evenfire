import { useEffect, useState } from 'react'
import type { DesktopAppInfo } from '../../../src/types'

export function formatDesktopAppVersionTooltip(info: DesktopAppInfo | null): string {
  if (!info) return 'Evenfire Desktop version unavailable'
  const runtime = info.isPackaged ? 'build' : 'local'
  return `${info.appName || 'Evenfire'} Desktop ${info.version} (${runtime})`
}

export function useDesktopAppInfo(): DesktopAppInfo | null {
  const [desktopAppInfo, setDesktopAppInfo] = useState<DesktopAppInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    const getDesktopAppInfo = window.clerum?.auth?.getDesktopAppInfo
    if (!getDesktopAppInfo) return undefined

    void getDesktopAppInfo()
      .then(info => {
        if (!cancelled) setDesktopAppInfo(info)
      })
      .catch(() => {
        if (!cancelled) setDesktopAppInfo(null)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return desktopAppInfo
}
