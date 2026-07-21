import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_TOAST_DURATION_MS } from '@constants/toasts'
import { desktopQueryClient } from '@lib/queryClient'
import type {
  DependencyHealth,
  DesktopReleaseStatus,
  DesktopRuntimeConfig,
  DesktopRuntimeConfigState,
  SessionMe,
} from '../../../../src/types'
import type { Tone } from '../../uiTypes'
import type { SetStatusFn } from './types'

interface UseAuthControllerParams {
  setStatus: SetStatusFn
  onSessionNeedsLoad: (options?: { preserveNav?: boolean }) => Promise<void>
}

function isInvitationExpiredError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error)
  return message.includes('410') || message.includes('invitation_expired')
}

function isMissingInvitationConfigError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error)
  return message.includes('404') || message.includes('invitation_config_not_found')
}

function isUnauthorizedError(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status?: unknown }).status)
    if (status === 401) return true
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error)
  return /\b401\s+unauthorized\b/.test(message) || /:\s*401\s/.test(message)
}

export function useAuthController({ setStatus, onSessionNeedsLoad }: UseAuthControllerParams) {
  const [booting, setBooting] = useState(true)
  const [busy, setBusy] = useState(false)
  const [statusText, setStatusText] = useState('Ready.')
  const [statusTone, setStatusTone] = useState<Tone>('info')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [me, setMe] = useState<SessionMe | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [desktopSetupAuthorizationToken, setDesktopSetupAuthorizationToken] = useState('')
  const [desktopSetupStarted, setDesktopSetupStarted] = useState(false)
  const [runtimeConfigSetupName, setRuntimeConfigSetupName] = useState('')
  const [runtimeConfigSetupExternalRestApiBaseUrl, setRuntimeConfigSetupExternalRestApiBaseUrl] =
    useState('')
  const [runtimeConfigSetupRpcProxyBaseUrl, setRuntimeConfigSetupRpcProxyBaseUrl] = useState('')
  const [authTransitioning, setAuthTransitioning] = useState(false)
  const [runtimeConfigState, setRuntimeConfigState] = useState<DesktopRuntimeConfigState | null>(
    null
  )
  const [dependencyHealth, setDependencyHealth] = useState<DependencyHealth | null>(null)
  const [desktopReleaseStatus, setDesktopReleaseStatus] = useState<DesktopReleaseStatus | null>(
    null
  )
  const [desktopEnvironmentSetupComplete, setDesktopEnvironmentSetupComplete] = useState(false)
  const [pendingDesktopEnvironmentSetup, setPendingDesktopEnvironmentSetup] =
    useState<DesktopRuntimeConfig | null>(null)

  const runtimeConfigMissing = Boolean(runtimeConfigState && !runtimeConfigState.configured)
  const showRuntimeConfigSelector = Boolean(
    runtimeConfigState &&
    runtimeConfigState.selectorVisible &&
    runtimeConfigState.options.length > 0
  )
  const hasDependencyOutage = Boolean(
    isAuthenticated &&
    dependencyHealth &&
    (!dependencyHealth.externalRestApi.ok || !dependencyHealth.rpcProxy.ok)
  )

  const refreshRuntimeConfigState = useCallback(async () => {
    const state = await window.clerum.auth.getRuntimeConfigState()
    setRuntimeConfigState(state)
    return state
  }, [])

  const completeDesktopSetupWith = useCallback(
    async (nextEmail: string, nextAuthorizationToken: string) => {
      const normalizedEmail = nextEmail.trim().toLowerCase()
      if (!normalizedEmail || !nextAuthorizationToken.trim()) {
        throw new Error('email and authorization token are required')
      }
      const state = await window.clerum.auth.completeDesktopSetup(
        normalizedEmail,
        nextAuthorizationToken.trim()
      )
      setRuntimeConfigState(state)
      setEmail(normalizedEmail)
      setDesktopSetupAuthorizationToken('')
      setDesktopSetupStarted(false)
      setStatus('Desktop setup complete. Sign in with your email and password.', 'success')
    },
    [setStatus]
  )

  // Boot effect
  useEffect(() => {
    refreshRuntimeConfigState().catch(() => undefined)
    onSessionNeedsLoad().catch(error => {
      setStatus(
        `Startup failed: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      setBooting(false)
    })
  }, [refreshRuntimeConfigState])

  // onDesktopSetupToken IPC listener effect
  useEffect(() => {
    return window.clerum.auth.onDesktopSetupToken(({ email: nextEmail, authorizationToken }) => {
      const normalizedEmail = nextEmail.trim().toLowerCase()
      setEmail(normalizedEmail)
      setDesktopSetupAuthorizationToken(authorizationToken)
      setDesktopSetupStarted(true)
      setBusy(true)
      setAuthTransitioning(true)
      completeDesktopSetupWith(normalizedEmail, authorizationToken)
        .catch(() => {
          setStatus('Desktop setup could not be completed.', 'error')
        })
        .finally(() => {
          setAuthTransitioning(false)
          setBusy(false)
        })
    })
  }, [completeDesktopSetupWith, setStatus])

  useEffect(() => {
    return window.clerum.auth.onDesktopEnvironmentSetup(({ externalRestApiBaseUrl, appName }) => {
      const normalizedExternalRestApiBaseUrl = externalRestApiBaseUrl.trim()
      if (!normalizedExternalRestApiBaseUrl) return
      try {
        const url = new URL(normalizedExternalRestApiBaseUrl)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('Only http(s) desktop environment URLs are supported')
        }
      } catch (error) {
        setStatus(
          `Desktop setup link rejected: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
        return
      }
      setPendingDesktopEnvironmentSetup({
        externalRestApiBaseUrl: normalizedExternalRestApiBaseUrl,
        rpcProxyBaseUrl: '',
        appName: appName?.trim() || 'Evenfire',
      })
    })
  }, [setStatus])

  useEffect(() => {
    return window.clerum.auth.onExternalLogout(() => {
      setIsAuthenticated(false)
      setMe(null)
      setPassword('')
      setStatus('Signed out after password update.', 'info')
    })
  }, [setStatus])

  const handlePasswordLogin = async () => {
    try {
      setBusy(true)
      setAuthTransitioning(true)
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail || !password) throw new Error('email and password are required')
      await window.clerum.auth.passwordLogin(normalizedEmail, password)
      setStatus('Signed in.', 'success')
      await onSessionNeedsLoad({ preserveNav: true })
    } catch (error) {
      const unauthorized = isUnauthorizedError(error)
      setStatus(
        isInvitationExpiredError(error)
          ? 'Invitation expired.'
          : isMissingInvitationConfigError(error)
            ? 'You must be invited to be part of a team.'
            : unauthorized
              ? 'Email or password is incorrect.'
              : 'Login failed. Check your email and password.',
        'error',
        undefined,
        unauthorized ? { toastDurationMs: DEFAULT_TOAST_DURATION_MS } : undefined
      )
    } finally {
      setAuthTransitioning(false)
      setBusy(false)
    }
  }

  const handleStartDesktopSetup = async () => {
    try {
      setBusy(true)
      setAuthTransitioning(true)
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail) throw new Error('email is required')
      await window.clerum.auth.startDesktopSetup(normalizedEmail)
      setDesktopSetupStarted(true)
      setStatus('Check your browser to authorize desktop setup.', 'success')
    } catch (error) {
      setStatus(
        isMissingInvitationConfigError(error)
          ? 'You must be invited to be part of a team.'
          : 'Desktop setup could not be started.',
        'error'
      )
    } finally {
      setAuthTransitioning(false)
      setBusy(false)
    }
  }

  const handleCompleteDesktopSetup = async () => {
    try {
      setBusy(true)
      setAuthTransitioning(true)
      await completeDesktopSetupWith(email, desktopSetupAuthorizationToken)
    } catch {
      setStatus('Desktop setup could not be completed.', 'error')
    } finally {
      setAuthTransitioning(false)
      setBusy(false)
    }
  }

  const handleSaveRuntimeConfig = async (
    nextConfig?: DesktopRuntimeConfig
  ): Promise<DesktopRuntimeConfigState | null> => {
    try {
      setBusy(true)
      const name = (nextConfig?.appName ?? runtimeConfigSetupName).trim()
      const externalRestApiBaseUrl = (
        nextConfig?.externalRestApiBaseUrl ?? runtimeConfigSetupExternalRestApiBaseUrl
      ).trim()
      const rpcProxyBaseUrl = (
        nextConfig?.rpcProxyBaseUrl ?? runtimeConfigSetupRpcProxyBaseUrl
      ).trim()
      if (!name || !externalRestApiBaseUrl) {
        throw new Error('environment name and external REST API are required')
      }

      const state = await window.clerum.auth.saveRuntimeConfig({
        externalRestApiBaseUrl,
        rpcProxyBaseUrl,
        appName: name,
      })
      setRuntimeConfigState(state)
      setRuntimeConfigSetupName('')
      setRuntimeConfigSetupExternalRestApiBaseUrl('')
      setRuntimeConfigSetupRpcProxyBaseUrl('')
      const selected = state.options.find(option => option.id === state.activeOptionId)
      setStatus(
        selected ? `Environment saved: ${selected.label}.` : `Environment saved: ${name}.`,
        'success',
        undefined,
        { global: false, toast: true }
      )
      return state
    } catch (error) {
      setStatus(
        `Environment setup failed: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      return null
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteRuntimeConfig = async (optionId: string) => {
    try {
      setBusy(true)
      // During npm-run-dev, Vite can hot-reload renderer code while Electron is
      // still using the old preload script. Surface the real recovery step.
      if (typeof window.clerum.auth.deleteRuntimeConfig !== 'function') {
        throw new Error('Restart the desktop app to finish loading the environment delete action')
      }
      const state = await window.clerum.auth.deleteRuntimeConfig(optionId)
      setRuntimeConfigState(state)
      setStatus('Environment deleted.', 'success', undefined, { global: false, toast: true })
    } catch (error) {
      setStatus(
        `Failed to delete environment: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    } finally {
      setBusy(false)
    }
  }

  const handleSelectRuntimeConfig = async (
    optionId: string
  ): Promise<DesktopRuntimeConfigState | null> => {
    try {
      setBusy(true)
      const state = await window.clerum.auth.selectRuntimeConfig(optionId)
      // Switching environment (pre-login) must not carry another env's cached
      // queries forward (spec §5.2 P1). The env is bound to login (D4: no switch
      // without logout), so a full clear is sufficient — no per-env query keys.
      desktopQueryClient.clear()
      setRuntimeConfigState(state)
      setDesktopSetupAuthorizationToken('')
      setDesktopSetupStarted(false)
      const selected = state.options.find(option => option.id === state.activeOptionId)
      setStatus(
        selected ? `Environment selected: ${selected.label}.` : 'Environment selected.',
        'success',
        undefined,
        { global: false, toast: true }
      )
      return state
    } catch (error) {
      setStatus(
        `Failed to switch environment: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      return null
    } finally {
      setBusy(false)
    }
  }

  const handleClearRuntimeConfigSelection = async (): Promise<DesktopRuntimeConfigState | null> => {
    try {
      setBusy(true)
      const state = await window.clerum.auth.clearRuntimeConfigSelection()
      setRuntimeConfigState(state)
      setStatus('Environment unselected.', 'success', undefined, {
        global: false,
        toast: true,
      })
      return state
    } catch (error) {
      setStatus(
        `Failed to unselect environment: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      return null
    } finally {
      setBusy(false)
    }
  }

  const handleCancelDesktopEnvironmentSetup = () => {
    setPendingDesktopEnvironmentSetup(null)
    setStatus('Desktop environment setup cancelled.', 'info', undefined, {
      global: false,
      toast: true,
    })
  }

  const handleConfirmDesktopEnvironmentSetup = async (): Promise<void> => {
    const nextConfig = pendingDesktopEnvironmentSetup
    if (!nextConfig) return
    setAuthTransitioning(true)
    try {
      const state = await handleSaveRuntimeConfig(nextConfig)
      if (!state) return
      setPendingDesktopEnvironmentSetup(null)
      setDesktopEnvironmentSetupComplete(true)
      setStatus('Desktop environment saved.', 'success')
    } finally {
      setAuthTransitioning(false)
    }
  }

  const refreshDesktopReleaseStatus = async (): Promise<DesktopReleaseStatus | null> => {
    try {
      const status = await window.clerum.auth.getDesktopReleaseStatus()
      setDesktopReleaseStatus(status)
      return status
    } catch {
      return null
    }
  }

  const handleOpenDesktopRelease = async () => {
    const releaseUrl = desktopReleaseStatus?.releaseUrl || ''
    if (!releaseUrl) return
    await window.clerum.auth.openDesktopRelease(releaseUrl)
  }

  return {
    booting,
    busy,
    statusText,
    statusTone,
    isAuthenticated,
    me,
    email,
    password,
    desktopSetupAuthorizationToken,
    desktopSetupStarted,
    runtimeConfigSetupName,
    runtimeConfigSetupExternalRestApiBaseUrl,
    runtimeConfigSetupRpcProxyBaseUrl,
    authTransitioning,
    runtimeConfigState,
    dependencyHealth,
    desktopReleaseStatus,
    desktopEnvironmentSetupComplete,
    pendingDesktopEnvironmentSetup,
    runtimeConfigMissing,
    showRuntimeConfigSelector,
    hasDependencyOutage,
    setBooting,
    setBusy,
    setStatusText,
    setStatusTone,
    setIsAuthenticated,
    setMe,
    setEmail,
    setPassword,
    setDesktopSetupAuthorizationToken,
    setRuntimeConfigSetupName,
    setRuntimeConfigSetupExternalRestApiBaseUrl,
    setRuntimeConfigSetupRpcProxyBaseUrl,
    setAuthTransitioning,
    setDependencyHealth,
    setDesktopReleaseStatus,
    setDesktopEnvironmentSetupComplete,
    setPendingDesktopEnvironmentSetup,
    refreshRuntimeConfigState,
    handlePasswordLogin,
    handleStartDesktopSetup,
    handleCompleteDesktopSetup,
    handleSaveRuntimeConfig,
    handleDeleteRuntimeConfig,
    handleSelectRuntimeConfig,
    handleClearRuntimeConfigSelection,
    handleCancelDesktopEnvironmentSetup,
    handleConfirmDesktopEnvironmentSetup,
    refreshDesktopReleaseStatus,
    handleOpenDesktopRelease,
  }
}
