import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_TOAST_DURATION_MS } from '@constants/toasts'
import { ipcErrorCode } from '@lib/ipcErrorCode'
import { desktopQueryClient } from '@lib/queryClient'
import { classifySignInFailure } from '@lib/signInFailure'
import type {
  DependencyHealth,
  DesktopReleaseStatus,
  DesktopRuntimeConfig,
  DesktopRuntimeConfigHandoffSelection,
  DesktopRuntimeConfigState,
  LoginBackendHint,
  SessionMe,
} from '../../../../src/types'
import type { Tone } from '../../uiTypes'
import {
  createDesktopEnvironmentSetupHandler,
  reportDesktopEnvironmentSelected,
  resolveDesktopEnvironmentRestMatch,
} from './desktopEnvironmentHandoff'
import type { DesktopEnvironmentSwitchConfirmation, SetStatusFn } from './types'
import { useBrowserSignIn } from './useBrowserSignIn'
import { useLoginMethods } from './useLoginMethods'

interface UseAuthControllerParams {
  setStatus: SetStatusFn
  onSessionNeedsLoad: (options?: { preserveNav?: boolean }) => Promise<void>
  onSessionEnded: () => void
  logoutForEnvironmentMismatch: () => Promise<number | null>
}

// The code main raises for desktop setup, whole, bare or inside the IPC wrapper.
function isMissingInvitationConfigError(error: unknown) {
  return ipcErrorCode(error, ['invitation_config_not_found']) !== null
}

function describeLoginWait(seconds: number): string {
  if (seconds <= 1) return 'in about a second'
  if (seconds <= 90) return `in about ${seconds} seconds`
  const minutes = Math.ceil(seconds / 60)
  return `in about ${minutes} minutes`
}

/**
 * The server did not verify the password on this path, so the text must not suggest that
 * the password is wrong. It holds for every admission reason behind a 429.
 */
function rateLimitedLoginMessage(retryAfterSeconds: number | null): string {
  const wait =
    retryAfterSeconds === null ? 'in a little while' : describeLoginWait(retryAfterSeconds)
  return `Sign-in is paused for now. Your password was not checked. Please try again ${wait}.`
}

function getDesktopSetupErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('auth_transition_in_progress')) {
    return 'Finish the current authentication action, then try desktop setup again.'
  }
  if (message.includes('stale_session_generation')) {
    return 'The desktop session changed while setup was in progress. Try desktop setup again.'
  }
  if (message.includes('desktop_setup_requires_signout')) {
    return 'Sign out before setting up another desktop environment.'
  }
  return 'Desktop setup could not be completed.'
}

export function useAuthController({
  setStatus,
  onSessionNeedsLoad,
  onSessionEnded,
  logoutForEnvironmentMismatch,
}: UseAuthControllerParams) {
  const [booting, setBootingState] = useState(true)
  const bootingRef = useRef(true)
  const setBooting = useCallback((next: boolean) => {
    bootingRef.current = next
    setBootingState(next)
  }, [])
  const [busy, setBusyState] = useState(false)
  const busyRef = useRef(false)
  const setBusy = useCallback((next: boolean) => {
    busyRef.current = next
    setBusyState(next)
  }, [])
  const [statusText, setStatusText] = useState('Ready.')
  const [statusTone, setStatusTone] = useState<Tone>('info')
  const [isAuthenticated, setIsAuthenticatedState] = useState(false)
  const isAuthenticatedRef = useRef(false)
  const setIsAuthenticated = useCallback((next: boolean) => {
    isAuthenticatedRef.current = next
    setIsAuthenticatedState(next)
  }, [])
  const [me, setMe] = useState<SessionMe | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [desktopSetupAuthorizationToken, setDesktopSetupAuthorizationToken] = useState('')
  const [desktopSetupStarted, setDesktopSetupStarted] = useState(false)
  const [runtimeConfigSetupName, setRuntimeConfigSetupName] = useState('')
  const [runtimeConfigSetupExternalRestApiBaseUrl, setRuntimeConfigSetupExternalRestApiBaseUrl] =
    useState('')
  const [runtimeConfigSetupRpcProxyBaseUrl, setRuntimeConfigSetupRpcProxyBaseUrl] = useState('')
  const [authTransitioning, setAuthTransitioningState] = useState(false)
  const authTransitioningRef = useRef(false)
  const setAuthTransitioning = useCallback((next: boolean) => {
    authTransitioningRef.current = next
    setAuthTransitioningState(next)
  }, [])
  const [runtimeConfigState, setRuntimeConfigState] = useState<DesktopRuntimeConfigState | null>(
    null
  )
  const [dependencyHealth, setDependencyHealth] = useState<DependencyHealth | null>(null)
  const [desktopReleaseStatus, setDesktopReleaseStatus] = useState<DesktopReleaseStatus | null>(
    null
  )
  const [backendSwitchHint, setBackendSwitchHint] = useState<LoginBackendHint | null>(null)
  const [desktopEnvironmentSetupComplete, setDesktopEnvironmentSetupComplete] = useState(false)
  const [pendingDesktopEnvironmentSetup, setPendingDesktopEnvironmentSetup] =
    useState<DesktopRuntimeConfig | null>(null)
  const [
    pendingDesktopEnvironmentSwitchConfirmation,
    setPendingDesktopEnvironmentSwitchConfirmation,
  ] = useState<DesktopEnvironmentSwitchConfirmation | null>(null)
  const desktopEnvironmentSwitchConfirmationResolver = useRef<
    ((confirmed: boolean) => void) | null
  >(null)

  const requestEnvironmentSwitchConfirmation = useCallback(
    (details: DesktopEnvironmentSwitchConfirmation) =>
      new Promise<boolean>(resolve => {
        desktopEnvironmentSwitchConfirmationResolver.current?.(false)
        desktopEnvironmentSwitchConfirmationResolver.current = resolve
        setPendingDesktopEnvironmentSwitchConfirmation(details)
      }),
    []
  )

  const resolveEnvironmentSwitchConfirmation = useCallback((confirmed: boolean) => {
    const resolve = desktopEnvironmentSwitchConfirmationResolver.current
    desktopEnvironmentSwitchConfirmationResolver.current = null
    setPendingDesktopEnvironmentSwitchConfirmation(null)
    resolve?.(confirmed)
  }, [])

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

  // Every call that can change the environment binding goes through `runBindingChange` (D15).
  const loginMethods = useLoginMethods({ refreshRuntimeConfigState })
  const { runBindingChange } = loginMethods
  // `refresh` is stable, so the browser sign-in's callbacks keep their identity (P42).
  const browserSignIn = useBrowserSignIn({
    setStatus,
    onSessionNeedsLoad,
    refreshLoginMethods: loginMethods.refresh,
  })
  /**
   * A browser sign-in that redeems blocks every other auth action (D14). It is read from the
   * hook's ref, so it holds before React commits the view (V32, A3-55). It is never written to
   * `authTransitioningRef`, which other flows' `finally` blocks clear (X3).
   *
   * The environment changes outside a desktop-environment link (save from the add form, select,
   * the backend switch, delete and clear) return at once while it holds, with no call to main
   * and no epoch move (Task 14a review I-1). Main does not refuse them while an attempt
   * redeems. One that moves the binding advances the generation, so main discards the redeem's
   * answer and ends the sign-in `replaced`, which shows nothing (decision 5). Delete and clear
   * are refused even when they would not move it, so all five behave alike. The page also
   * disables those controls; reading the ref here covers a click that lands before that state
   * commits. Nothing is shown: the sign-in's own outcome follows.
   */
  const browserSignInBlocksAuthActions = browserSignIn.isRedeeming

  const getDesktopEnvironmentHandoffAuthState = useCallback(
    () => ({
      booting: bootingRef.current,
      busy: busyRef.current,
      authTransitioning: authTransitioningRef.current || browserSignInBlocksAuthActions(),
      isAuthenticated: isAuthenticatedRef.current,
    }),
    [browserSignInBlocksAuthActions]
  )

  const getSessionGeneration = useCallback(() => window.clerum.auth.getSessionGeneration(), [])

  const completeDesktopSetupWith = useCallback(
    async (nextEmail: string, nextAuthorizationToken: string) => {
      const normalizedEmail = nextEmail.trim().toLowerCase()
      if (!normalizedEmail || !nextAuthorizationToken.trim()) {
        throw new Error('email and authorization token are required')
      }
      const state = await runBindingChange(() =>
        window.clerum.auth.completeDesktopSetup(normalizedEmail, nextAuthorizationToken.trim())
      )
      setRuntimeConfigState(state)
      setEmail(normalizedEmail)
      setDesktopSetupAuthorizationToken('')
      setDesktopSetupStarted(false)
      setStatus('Desktop setup complete. Sign in to continue.', 'success')
    },
    [runBindingChange, setStatus]
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
        .catch(error => {
          setStatus(getDesktopSetupErrorMessage(error), 'error')
        })
        .finally(() => {
          setAuthTransitioning(false)
          setBusy(false)
        })
    })
  }, [completeDesktopSetupWith, setStatus])

  useEffect(() => {
    return window.clerum.auth.onExternalLogout(() => {
      onSessionEnded()
      setIsAuthenticated(false)
      setMe(null)
      setPassword('')
      setStatus('Signed out after password update.', 'info')
    })
  }, [onSessionEnded, setStatus])

  // Main ended the committed session (control-api rejected it). Loading the
  // session again runs the same signed-out transition as a failed restore.
  useEffect(() => {
    return window.clerum.auth.onSessionCleared(() => {
      setStatus('Your session ended. Sign in again.', 'info')
      onSessionNeedsLoad().catch(error => {
        setStatus(
          `Your session ended, but the desktop could not refresh it: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'warn'
        )
      })
    })
  }, [onSessionNeedsLoad, setStatus])

  const handlePasswordLogin = async () => {
    try {
      setBusy(true)
      setAuthTransitioning(true)
      setBackendSwitchHint(null)
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail || !password) throw new Error('email and password are required')
      await window.clerum.auth.passwordLogin(normalizedEmail, password)
      setStatus('Signed in.', 'success')
      await onSessionNeedsLoad({ preserveNav: true })
    } catch (error) {
      const failure = classifySignInFailure(error instanceof Error ? error.message : String(error))
      // A 401 or a 429 means the backend answered, so no switch to another backend is
      // offered.
      if (failure.kind === 'invalid_credentials') {
        setStatus('Email or password is incorrect.', 'error', undefined, {
          toastDurationMs: DEFAULT_TOAST_DURATION_MS,
        })
        return
      }
      if (failure.kind === 'rate_limited') {
        setStatus(rateLimitedLoginMessage(failure.retryAfterSeconds), 'error')
        return
      }
      setStatus(
        failure.kind === 'unavailable'
          ? "Sign-in isn't available right now. Please try again in a moment."
          : 'Login failed. Check your email and password.',
        'error'
      )
      // Any other failure can be the signature of a login aimed at a backend that
      // isn't answering — most often the app is on a saved profile while a local
      // minikube cluster is what's actually up. Only then do we probe for a reachable
      // localhost and, if found, offer a one-click switch.
      try {
        const hint =
          typeof window.clerum.auth.diagnoseLoginBackend === 'function'
            ? await window.clerum.auth.diagnoseLoginBackend()
            : null
        setBackendSwitchHint(hint)
      } catch {
        setBackendSwitchHint(null)
      }
    } finally {
      setAuthTransitioning(false)
      setBusy(false)
    }
  }

  const handleSwitchLoginBackend = async () => {
    const hint = backendSwitchHint
    if (!hint) return
    // Before the hint is cleared, so the switch stays offered (I-1).
    if (browserSignInBlocksAuthActions()) return
    setBackendSwitchHint(null)
    const state = await handleSelectRuntimeConfig(hint.targetOptionId)
    if (!state) return
    await handlePasswordLogin()
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
    } catch (error) {
      setStatus(getDesktopSetupErrorMessage(error), 'error')
    } finally {
      setAuthTransitioning(false)
      setBusy(false)
    }
  }

  const handleSaveRuntimeConfig = async (
    nextConfig?: DesktopRuntimeConfig,
    expectedSessionGeneration?: number
  ): Promise<DesktopRuntimeConfigState | null> => {
    // A link's save carries a generation: its confirm checks the blocker, and main refuses it
    // while an attempt redeems (D11). The add form's save does not (I-1).
    if (expectedSessionGeneration === undefined && browserSignInBlocksAuthActions()) return null
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

      const configToSave = {
        externalRestApiBaseUrl,
        rpcProxyBaseUrl,
        appName: name,
      }
      const state = await runBindingChange(() =>
        expectedSessionGeneration === undefined
          ? window.clerum.auth.saveRuntimeConfig(configToSave)
          : window.clerum.auth.saveRuntimeConfig(configToSave, expectedSessionGeneration)
      )
      setRuntimeConfigState(state)
      setRuntimeConfigSetupName('')
      setRuntimeConfigSetupExternalRestApiBaseUrl('')
      setRuntimeConfigSetupRpcProxyBaseUrl('')
      // Linked confirmation owns success feedback after verifying the active profile.
      if (expectedSessionGeneration === undefined) {
        const selected = state.options.find(option => option.id === state.activeOptionId)
        setStatus(
          selected ? `Environment saved: ${selected.label}.` : `Environment saved: ${name}.`,
          'success',
          undefined,
          { global: false, toast: true }
        )
      }
      return state
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        expectedSessionGeneration !== undefined &&
        message.includes('auth_transition_in_progress')
      ) {
        setPendingDesktopEnvironmentSetup(null)
        setStatus(
          'Finish the current authentication action, then reopen this desktop link.',
          'info'
        )
      } else if (
        expectedSessionGeneration !== undefined &&
        (message.includes('stale_session_generation') ||
          message.includes('desktop_setup_requires_signout'))
      ) {
        setPendingDesktopEnvironmentSetup(null)
        setStatus('The desktop session changed while processing this link. Open it again.', 'info')
      } else {
        setStatus(`Environment setup failed: ${message}`, 'error')
      }
      return null
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteRuntimeConfig = async (optionId: string) => {
    if (browserSignInBlocksAuthActions()) return
    try {
      setBusy(true)
      // During npm-run-dev, Vite can hot-reload renderer code while Electron is
      // still using the old preload script. Surface the real recovery step.
      if (typeof window.clerum.auth.deleteRuntimeConfig !== 'function') {
        throw new Error('Restart the desktop app to finish loading the environment delete action')
      }
      const state = await runBindingChange(() => window.clerum.auth.deleteRuntimeConfig(optionId))
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

  const applySelectedRuntimeConfigState = useCallback((state: DesktopRuntimeConfigState) => {
    // Switching environment (pre-login) must not carry another env's cached
    // queries forward (spec §5.2 P1). The env is bound to login (D4: no switch
    // without logout), so a full clear is sufficient — no per-env query keys.
    desktopQueryClient.clear()
    setRuntimeConfigState(state)
    setDesktopSetupAuthorizationToken('')
    setDesktopSetupStarted(false)
  }, [])

  const handleSelectRuntimeConfig = useCallback(
    async (optionId: string): Promise<DesktopRuntimeConfigState | null> => {
      if (browserSignInBlocksAuthActions()) return null
      try {
        setBusy(true)
        setBackendSwitchHint(null)
        const state = await runBindingChange(() => window.clerum.auth.selectRuntimeConfig(optionId))
        applySelectedRuntimeConfigState(state)
        reportDesktopEnvironmentSelected(state, setStatus)
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
    },
    [applySelectedRuntimeConfigState, browserSignInBlocksAuthActions, runBindingChange, setStatus]
  )

  const handleSelectRuntimeConfigForHandoff = useCallback(
    async (
      optionId: string,
      expectedSessionGeneration: number
    ): Promise<DesktopRuntimeConfigHandoffSelection | null> => {
      try {
        setBusy(true)
        setBackendSwitchHint(null)
        const selection = await runBindingChange(() =>
          window.clerum.auth.selectRuntimeConfigForHandoff(optionId, expectedSessionGeneration)
        )
        applySelectedRuntimeConfigState(selection.runtimeConfigState)
        if (selection.runtimeConfigState.activeOptionId !== optionId) {
          throw new Error(
            'Selected desktop environment does not match the requested saved profile.'
          )
        }
        return selection
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('stale_session_generation')) {
          setStatus(
            'The desktop session changed while processing this link. Open it again.',
            'info'
          )
          return null
        }
        if (message.includes('auth_transition_in_progress')) {
          setStatus(
            'Finish the current authentication action, then reopen this desktop link.',
            'info'
          )
          return null
        }
        if (message.includes('desktop_setup_requires_signout')) {
          setStatus(
            'The desktop session changed while processing this link. Open it again.',
            'info'
          )
          return null
        }
        setStatus(`Failed to switch environment: ${message}`, 'error')
        return null
      } finally {
        setBusy(false)
      }
    },
    [applySelectedRuntimeConfigState, runBindingChange, setStatus]
  )

  useEffect(() => {
    const unsubscribe = window.clerum.auth.onDesktopEnvironmentSetup(
      createDesktopEnvironmentSetupHandler({
        getAuthState: getDesktopEnvironmentHandoffAuthState,
        getSessionGeneration,
        refreshRuntimeConfigState,
        handleSelectRuntimeConfig: handleSelectRuntimeConfigForHandoff,
        onSessionNeedsLoad,
        requestEnvironmentSwitchConfirmation,
        logoutForEnvironmentMismatch,
        setPendingDesktopEnvironmentSetup,
        setStatus,
      })
    )
    return () => {
      unsubscribe()
      const resolve = desktopEnvironmentSwitchConfirmationResolver.current
      desktopEnvironmentSwitchConfirmationResolver.current = null
      setPendingDesktopEnvironmentSwitchConfirmation(null)
      resolve?.(false)
    }
  }, [
    getDesktopEnvironmentHandoffAuthState,
    getSessionGeneration,
    handleSelectRuntimeConfigForHandoff,
    logoutForEnvironmentMismatch,
    onSessionNeedsLoad,
    requestEnvironmentSwitchConfirmation,
    refreshRuntimeConfigState,
    setStatus,
  ])

  const handleClearRuntimeConfigSelection = async (): Promise<DesktopRuntimeConfigState | null> => {
    if (browserSignInBlocksAuthActions()) return null
    try {
      setBusy(true)
      const state = await runBindingChange(() => window.clerum.auth.clearRuntimeConfigSelection())
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

  const handleCancelDesktopEnvironmentSwitchConfirmation = useCallback(() => {
    resolveEnvironmentSwitchConfirmation(false)
    setStatus(
      'Environment switch cancelled. Your current session remains active.',
      'info',
      undefined,
      {
        global: false,
        toast: true,
      }
    )
  }, [resolveEnvironmentSwitchConfirmation, setStatus])

  const handleConfirmDesktopEnvironmentSwitchConfirmation = useCallback(() => {
    resolveEnvironmentSwitchConfirmation(true)
  }, [resolveEnvironmentSwitchConfirmation])

  const handleConfirmDesktopEnvironmentSetup = async (): Promise<void> => {
    const nextConfig = pendingDesktopEnvironmentSetup
    if (!nextConfig) return

    const reportSessionChanged = () => {
      setPendingDesktopEnvironmentSetup(null)
      setStatus('The desktop session changed while processing this link. Open it again.', 'info')
    }
    const reportAuthenticationInProgress = () => {
      setPendingDesktopEnvironmentSetup(null)
      setStatus('Finish the current authentication action, then reopen this desktop link.', 'info')
    }

    if (
      bootingRef.current ||
      busyRef.current ||
      authTransitioningRef.current ||
      browserSignInBlocksAuthActions()
    ) {
      reportAuthenticationInProgress()
      return
    }
    if (isAuthenticatedRef.current) {
      reportSessionChanged()
      return
    }

    setAuthTransitioning(true)
    try {
      let expectedSessionGeneration: number
      try {
        expectedSessionGeneration = await getSessionGeneration()
      } catch {
        setPendingDesktopEnvironmentSetup(null)
        setStatus('Could not verify the desktop session. Try opening the link again.', 'error')
        return
      }
      if (bootingRef.current || busyRef.current || browserSignInBlocksAuthActions()) {
        reportAuthenticationInProgress()
        return
      }
      if (isAuthenticatedRef.current) {
        reportSessionChanged()
        return
      }

      let currentConfigState: DesktopRuntimeConfigState
      try {
        currentConfigState = await refreshRuntimeConfigState()
      } catch {
        setPendingDesktopEnvironmentSetup(null)
        setStatus('Could not verify the desktop environment. Try opening it again.', 'error')
        return
      }

      let currentSessionGeneration: number
      try {
        currentSessionGeneration = await getSessionGeneration()
      } catch {
        setPendingDesktopEnvironmentSetup(null)
        setStatus('Could not verify the desktop session. Try opening the link again.', 'error')
        return
      }
      if (currentSessionGeneration !== expectedSessionGeneration || isAuthenticatedRef.current) {
        reportSessionChanged()
        return
      }
      if (bootingRef.current || busyRef.current || browserSignInBlocksAuthActions()) {
        reportAuthenticationInProgress()
        return
      }

      const restMatch = resolveDesktopEnvironmentRestMatch(
        currentConfigState,
        nextConfig.externalRestApiBaseUrl
      )

      if (restMatch.kind === 'localhost') {
        setPendingDesktopEnvironmentSetup(null)
        setStatus(
          'Desktop setup link rejected: the Localhost environment cannot be opened from a link.',
          'error'
        )
        return
      }

      if (restMatch.kind === 'active') {
        setPendingDesktopEnvironmentSetup(null)
        setStatus('This link points to the active Evenfire Desktop environment.', 'success')
        return
      }

      if (restMatch.kind === 'path-conflict') {
        setPendingDesktopEnvironmentSetup(null)
        setStatus(
          'Desktop setup link rejected because this REST host is already saved with a different API endpoint.',
          'error'
        )
        return
      }

      if (restMatch.kind === 'ambiguous') {
        setPendingDesktopEnvironmentSetup(null)
        setStatus(
          'Desktop setup link rejected because multiple saved environments use this REST API.',
          'error'
        )
        return
      }

      if (restMatch.kind === 'saved') {
        const savedOption = restMatch.option
        const selection = await handleSelectRuntimeConfigForHandoff(
          savedOption.id,
          expectedSessionGeneration
        )
        if (!selection) {
          setPendingDesktopEnvironmentSetup(null)
          return
        }
        let selectedSessionGeneration: number
        try {
          selectedSessionGeneration = await getSessionGeneration()
        } catch {
          setPendingDesktopEnvironmentSetup(null)
          setStatus('Could not verify the desktop session. Try opening the link again.', 'error')
          return
        }
        if (selectedSessionGeneration !== selection.sessionGeneration) {
          reportSessionChanged()
          return
        }
        // Redeeming cannot hold here with the real main: it refuses the selection while an
        // attempt redeems (`assertProfileHandoffSessionIsSignedOut`, D11), and an attempt
        // started after the selection advances the generation, which the check above reports.
        // This read of the browser sign-in only backs those two up.
        if (busyRef.current || browserSignInBlocksAuthActions()) {
          reportAuthenticationInProgress()
          return
        }
        setPendingDesktopEnvironmentSetup(null)
        reportDesktopEnvironmentSelected(selection.runtimeConfigState, setStatus)
        try {
          await onSessionNeedsLoad({ preserveNav: true })
        } catch (error) {
          setStatus(
            `Could not load the selected desktop environment: ${error instanceof Error ? error.message : String(error)}`,
            'error'
          )
        }
        return
      }

      const state = await handleSaveRuntimeConfig(nextConfig, expectedSessionGeneration)
      if (!state) return
      const selectedOption = state.options.find(option => option.id === state.activeOptionId)
      const selectedRestMatch = resolveDesktopEnvironmentRestMatch(
        state,
        nextConfig.externalRestApiBaseUrl
      )
      const selectedRestMatches =
        selectedRestMatch.kind === 'active' ||
        (selectedRestMatch.kind === 'saved' && selectedRestMatch.option.id === state.activeOptionId)
      if (!selectedOption || !selectedRestMatches || !selectedOption.rpcProxyBaseUrl.trim()) {
        setPendingDesktopEnvironmentSetup(null)
        setStatus(
          'Desktop environment setup could not verify the confirmed REST and RPC endpoints.',
          'error'
        )
        return
      }
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

  const { start: startBrowserSignIn } = browserSignIn
  /**
   * Starts a browser sign-in (D5). The start control is disabled while another auth action
   * runs (D14, A3-68); the handler also returns at once then, for a click that lands before the
   * disabled state commits. The call sets `busy` while it is in flight, so the dock is disabled
   * until main answers; the waiting attempt then sets nothing.
   */
  const handleStartBrowserSignIn = useCallback(async () => {
    if (bootingRef.current || busyRef.current || authTransitioningRef.current) return
    setBusy(true)
    try {
      await startBrowserSignIn()
    } finally {
      setBusy(false)
    }
  }, [setBusy, startBrowserSignIn])

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
    // Decision 8: a redeeming browser sign-in reaches every reader of `authTransitioning`
    // without an edit there: the dock (`RuntimeConfigDock`) is disabled, and onboarding's invited
    // step (`InvitedMember`) shows its in-progress label, where main refuses setup anyway (D11).
    // The raw flag stays what the flows write and their `finally` blocks clear (X3).
    authTransitioning: authTransitioning || browserSignIn.view.phase === 'redeeming',
    runtimeConfigState,
    dependencyHealth,
    desktopReleaseStatus,
    desktopEnvironmentSetupComplete,
    pendingDesktopEnvironmentSetup,
    pendingDesktopEnvironmentSwitchConfirmation,
    backendSwitchHint,
    runtimeConfigMissing,
    showRuntimeConfigSelector,
    hasDependencyOutage,
    loginScreen: loginMethods.model,
    browserSignIn: browserSignIn.view,
    refreshLoginMethods: loginMethods.refresh,
    handleStartBrowserSignIn,
    handleCancelBrowserSignIn: browserSignIn.cancel,
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
    setBackendSwitchHint,
    refreshRuntimeConfigState,
    handlePasswordLogin,
    handleSwitchLoginBackend,
    handleStartDesktopSetup,
    handleCompleteDesktopSetup,
    handleSaveRuntimeConfig,
    handleDeleteRuntimeConfig,
    handleSelectRuntimeConfig,
    handleClearRuntimeConfigSelection,
    handleCancelDesktopEnvironmentSetup,
    handleConfirmDesktopEnvironmentSetup,
    handleCancelDesktopEnvironmentSwitchConfirmation,
    handleConfirmDesktopEnvironmentSwitchConfirmation,
    refreshDesktopReleaseStatus,
    handleOpenDesktopRelease,
  }
}
