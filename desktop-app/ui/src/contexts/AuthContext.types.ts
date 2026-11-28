import type {
  BrowserSignInSnapshot,
  DependencyHealth,
  DesktopReleaseStatus,
  DesktopRuntimeConfig,
  DesktopRuntimeConfigState,
  LoginBackendHint,
  SessionMe,
} from '../../../src/types'
import type { LoginScreenModel } from '../hooks/domain/types'
import type { Tone } from '../uiTypes'

export interface AuthContextValue {
  booting: boolean
  busy: boolean
  statusText: string
  statusTone: Tone
  isAuthenticated: boolean
  sessionGeneration?: number | null
  me: SessionMe | null
  email: string
  password: string
  desktopSetupAuthorizationToken: string
  desktopSetupStarted: boolean
  desktopEnvironmentSetupComplete: boolean
  runtimeConfigSetupName: string
  runtimeConfigSetupExternalRestApiBaseUrl: string
  runtimeConfigSetupRpcProxyBaseUrl: string
  authTransitioning: boolean
  runtimeConfigState: DesktopRuntimeConfigState | null
  desktopReleaseStatus: DesktopReleaseStatus | null
  pendingDesktopEnvironmentSetup: DesktopRuntimeConfig | null
  backendSwitchHint: LoginBackendHint | null
  runtimeConfigMissing: boolean
  showRuntimeConfigSelector: boolean
  dependencyHealth: DependencyHealth | null
  hasDependencyOutage: boolean
  /** The login screen's model, read from main (E12, D15). */
  loginScreen: LoginScreenModel
  /** Main's browser sign-in snapshot, the newest the renderer has seen (D13). */
  browserSignIn: BrowserSignInSnapshot
  /** Reads the login screen's model for the current binding; it never throws. */
  refreshLoginMethods: () => void
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
  handleSwitchLoginBackend: () => Promise<void>
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
  /** Starts a browser sign-in; it does nothing while another auth action runs (D14). */
  handleStartBrowserSignIn: () => Promise<void>
  /**
   * Cancels a waiting browser sign-in; it never rejects. A failed cancel is logged and, while the
   * attempt still waits, shows a fixed error. Main's pushes still lead.
   */
  handleCancelBrowserSignIn: () => Promise<void>
}
