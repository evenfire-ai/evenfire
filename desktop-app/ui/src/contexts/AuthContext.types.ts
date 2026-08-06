import type {
  DependencyHealth,
  DesktopReleaseStatus,
  DesktopRuntimeConfig,
  DesktopRuntimeConfigState,
  IdentityProviderConnection,
  SessionMe,
} from '../../../src/types'
import type { Tone } from '../uiTypes'

export interface AuthContextValue {
  booting: boolean
  busy: boolean
  statusText: string
  statusTone: Tone
  isAuthenticated: boolean
  me: SessionMe | null
  email: string
  password: string
  desktopSetupAuthorizationToken: string
  desktopSetupStarted: boolean
  desktopEnvironmentSetupComplete: boolean
  identityProviders: IdentityProviderConnection[]
  identityProvidersLoading: boolean
  runtimeConfigSetupName: string
  runtimeConfigSetupExternalRestApiBaseUrl: string
  runtimeConfigSetupRpcProxyBaseUrl: string
  authTransitioning: boolean
  runtimeConfigState: DesktopRuntimeConfigState | null
  desktopReleaseStatus: DesktopReleaseStatus | null
  pendingDesktopEnvironmentSetup: DesktopRuntimeConfig | null
  runtimeConfigMissing: boolean
  showRuntimeConfigSelector: boolean
  dependencyHealth: DependencyHealth | null
  hasDependencyOutage: boolean
  setBooting: (value: boolean) => void
  setEmail: (value: string) => void
  setPassword: (value: string) => void
  setDesktopSetupAuthorizationToken: (value: string) => void
  setDesktopEnvironmentSetupComplete: (value: boolean) => void
  setPendingDesktopEnvironmentSetup: (value: DesktopRuntimeConfig | null) => void
  setRuntimeConfigSetupName: (value: string) => void
  setRuntimeConfigSetupExternalRestApiBaseUrl: (value: string) => void
  setRuntimeConfigSetupRpcProxyBaseUrl: (value: string) => void
  setStatus: (
    message: string,
    tone?: Tone,
    payload?: unknown,
    options?: { global?: boolean; toast?: boolean }
  ) => void
  loadSession: (options?: { preserveNav?: boolean }) => Promise<void>
  handlePasswordLogin: () => Promise<void>
  handleMicrosoftIdentityProviderLogin: (connectionId: string) => Promise<void>
  handleStartDesktopSetup: () => Promise<void>
  handleCompleteDesktopSetup: () => Promise<void>
  handleSaveRuntimeConfig: (
    nextConfig?: DesktopRuntimeConfig
  ) => Promise<DesktopRuntimeConfigState | null>
  handleDeleteRuntimeConfig: (optionId: string) => Promise<void>
  handleSelectRuntimeConfig: (optionId: string) => Promise<DesktopRuntimeConfigState | null>
  handleClearRuntimeConfigSelection: () => Promise<DesktopRuntimeConfigState | null>
  handleCancelDesktopEnvironmentSetup: () => void
  handleConfirmDesktopEnvironmentSetup: () => Promise<void>
  handleOpenDesktopRelease: () => Promise<void>
  handleLogout: () => Promise<void>
}
