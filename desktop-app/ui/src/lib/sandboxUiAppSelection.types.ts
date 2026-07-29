import type { ActiveSandboxUiApp } from '@/uiTypes'
import type { SandboxUiApp } from '../../../src/rpcProxyClient'

export type SandboxUiAppListing = SandboxUiApp

export type SandboxUiDeepLinkAppResolution =
  | { status: 'ready'; app: ActiveSandboxUiApp }
  | { status: 'starting'; label: string; phase: string | null }
  | { status: 'unavailable' }
