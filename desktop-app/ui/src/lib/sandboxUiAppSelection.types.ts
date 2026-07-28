import type { ActiveSandboxUiApp } from '@/uiTypes'

export type SandboxUiAppListing = {
  appRef: string
  title?: string
  description?: string
  icon?: string
  defaultPath: string
  ready: boolean
  phase?: string | null
  updatedAt?: string | null
}

export type SandboxUiDeepLinkAppResolution =
  | { status: 'ready'; app: ActiveSandboxUiApp }
  | { status: 'starting'; label: string; phase: string | null }
  | { status: 'unavailable' }
