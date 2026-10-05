import {
  canonicalizeDesktopRestEndpoint,
  desktopRestEndpointOrigin,
  sameDesktopRestEndpoint,
} from '../../../../src/desktopEnvironmentUrl'
import type {
  DesktopRuntimeConfig,
  DesktopRuntimeConfigHandoffSelection,
  DesktopRuntimeConfigState,
} from '../../../../src/types'
import type { DesktopEnvironmentSwitchConfirmation, SetStatusFn } from './types'

const LOCALHOST_OPTION_ID = '__localhost__'

type DesktopEnvironmentHandoffState = {
  booting: boolean
  busy: boolean
  authTransitioning: boolean
  isAuthenticated: boolean
}

type DesktopEnvironmentSetupPayload = {
  externalRestApiBaseUrl: string
  appName?: string
}

type DesktopEnvironmentSetupHandlerOptions = {
  getAuthState: () => DesktopEnvironmentHandoffState
  getSessionGeneration: () => Promise<number>
  refreshRuntimeConfigState: () => Promise<DesktopRuntimeConfigState>
  handleSelectRuntimeConfig: (
    optionId: string,
    expectedSessionGeneration: number
  ) => Promise<DesktopRuntimeConfigHandoffSelection | null>
  onSessionNeedsLoad: (options?: { preserveNav?: boolean }) => Promise<void>
  requestEnvironmentSwitchConfirmation: (
    details: DesktopEnvironmentSwitchConfirmation
  ) => Promise<boolean>
  logoutForEnvironmentMismatch: () => Promise<number | null>
  setPendingDesktopEnvironmentSetup: (config: DesktopRuntimeConfig | null) => void
  setStatus: SetStatusFn
}

function savedEnvironmentsForRestEndpoint(
  options: DesktopRuntimeConfigState['options'],
  externalRestApiBaseUrl: string
) {
  return options.filter(option => {
    if (option.source === 'localhost' || option.id === LOCALHOST_OPTION_ID) return false
    return sameDesktopRestEndpoint(option.externalRestApiBaseUrl, externalRestApiBaseUrl)
  })
}

function isLocalhostOption(option: DesktopRuntimeConfigState['options'][number]): boolean {
  return option.source === 'localhost' || option.id === LOCALHOST_OPTION_ID
}

export function getDesktopEnvironmentRestMatches(
  configState: DesktopRuntimeConfigState,
  externalRestApiBaseUrl: string
) {
  const restOrigin = desktopRestEndpointOrigin(externalRestApiBaseUrl)
  return {
    localhost: configState.options.find(option => {
      if (!isLocalhostOption(option)) return false
      try {
        return desktopRestEndpointOrigin(option.externalRestApiBaseUrl) === restOrigin
      } catch {
        return false
      }
    }),
    saved: savedEnvironmentsForRestEndpoint(configState.options, externalRestApiBaseUrl),
  }
}

function isAuthenticationOperationInProgress(state: DesktopEnvironmentHandoffState): boolean {
  return state.booting || state.busy || state.authTransitioning
}

export function createDesktopEnvironmentSetupHandler({
  getAuthState,
  getSessionGeneration,
  refreshRuntimeConfigState,
  handleSelectRuntimeConfig,
  onSessionNeedsLoad,
  requestEnvironmentSwitchConfirmation,
  logoutForEnvironmentMismatch,
  setPendingDesktopEnvironmentSetup,
  setStatus,
}: DesktopEnvironmentSetupHandlerOptions) {
  let linkInProgress = false
  const ownsSessionGeneration = async (expectedSessionGeneration: number): Promise<boolean> => {
    try {
      return (await getSessionGeneration()) === expectedSessionGeneration
    } catch {
      setStatus('Could not verify the desktop session. Try opening the link again.', 'error')
      return false
    }
  }

  const processLink = async ({
    externalRestApiBaseUrl,
    appName,
  }: DesktopEnvironmentSetupPayload) => {
    const normalizedExternalRestApiBaseUrl = externalRestApiBaseUrl.trim()
    if (!normalizedExternalRestApiBaseUrl) return
    const linkedConfig: DesktopRuntimeConfig = {
      externalRestApiBaseUrl: normalizedExternalRestApiBaseUrl,
      rpcProxyBaseUrl: '',
      appName: appName?.trim() || 'Evenfire',
    }
    try {
      linkedConfig.externalRestApiBaseUrl = canonicalizeDesktopRestEndpoint(
        linkedConfig.externalRestApiBaseUrl
      )
    } catch (error) {
      setStatus(
        `Desktop setup link rejected: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      return
    }

    let sessionGeneration: number
    try {
      sessionGeneration = await getSessionGeneration()
    } catch {
      setStatus('Could not verify the desktop session. Try opening the link again.', 'error')
      return
    }

    if (isAuthenticationOperationInProgress(getAuthState())) {
      setStatus(
        'Finish the current authentication action before opening another desktop environment.',
        'info'
      )
      return
    }

    let configState: DesktopRuntimeConfigState
    try {
      configState = await refreshRuntimeConfigState()
    } catch {
      setStatus('Could not verify the desktop environment. Try opening it again.', 'error')
      return
    }

    if (!(await ownsSessionGeneration(sessionGeneration))) return

    let restMatches = getDesktopEnvironmentRestMatches(
      configState,
      linkedConfig.externalRestApiBaseUrl
    )
    if (restMatches.localhost) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus(
        'Desktop setup link rejected: the Localhost environment cannot be opened from a link.',
        'error'
      )
      return
    }

    let authState = getAuthState()
    const activeRestEndpointMatches = Boolean(
      configState.configured &&
      configState.currentConfig &&
      sameDesktopRestEndpoint(
        configState.currentConfig.externalRestApiBaseUrl,
        linkedConfig.externalRestApiBaseUrl
      )
    )
    if (authState.isAuthenticated && !activeRestEndpointMatches) {
      const switchConfirmed = await requestEnvironmentSwitchConfirmation({
        activeEnvironmentName: configState.currentConfig?.appName?.trim() || 'Current environment',
        activeExternalRestApiBaseUrl: configState.currentConfig?.externalRestApiBaseUrl || '',
        targetEnvironmentName: linkedConfig.appName || 'Evenfire',
        targetExternalRestApiBaseUrl: linkedConfig.externalRestApiBaseUrl,
      })
      if (!switchConfirmed) return
      if (!(await ownsSessionGeneration(sessionGeneration))) return

      authState = getAuthState()
      if (isAuthenticationOperationInProgress(authState) || !authState.isAuthenticated) return

      setPendingDesktopEnvironmentSetup(null)
      let logoutGeneration: number | null
      try {
        logoutGeneration = await logoutForEnvironmentMismatch()
      } catch (error) {
        setStatus(
          `Could not sign out before switching desktop environments: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
        return
      }
      if (logoutGeneration === null) {
        authState = getAuthState()
        if (authState.isAuthenticated && !isAuthenticationOperationInProgress(authState)) {
          try {
            await onSessionNeedsLoad({ preserveNav: true })
          } catch {
            // A failed logout must leave the current environment in place.
          }
        }
        return
      }
      sessionGeneration = logoutGeneration
      if (!(await ownsSessionGeneration(sessionGeneration))) return

      authState = getAuthState()
      if (isAuthenticationOperationInProgress(authState)) return
      if (authState.isAuthenticated) {
        try {
          await onSessionNeedsLoad({ preserveNav: true })
        } catch {
          if (!(await ownsSessionGeneration(sessionGeneration))) return
          setStatus(
            'Could not verify your sign-in state before switching desktop environments.',
            'error'
          )
          return
        }
        if (!(await ownsSessionGeneration(sessionGeneration))) return
        authState = getAuthState()
        if (authState.isAuthenticated) return
      }
      try {
        configState = await refreshRuntimeConfigState()
      } catch {
        setStatus('Could not verify the desktop environment. Try opening it again.', 'error')
        return
      }
      if (!(await ownsSessionGeneration(sessionGeneration))) return
      authState = getAuthState()
      if (isAuthenticationOperationInProgress(authState) || authState.isAuthenticated) return
      restMatches = getDesktopEnvironmentRestMatches(
        configState,
        linkedConfig.externalRestApiBaseUrl
      )
      if (restMatches.localhost) {
        setPendingDesktopEnvironmentSetup(null)
        setStatus(
          'Desktop setup link rejected: the Localhost environment cannot be opened from a link.',
          'error'
        )
        return
      }
    }

    if (authState.isAuthenticated) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus(`Opening ${linkedConfig.appName} in Evenfire Desktop.`, 'success')
      return
    }

    if (activeRestEndpointMatches) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus(`Opening ${linkedConfig.appName} in Evenfire Desktop.`, 'success')
      return
    }

    if (restMatches.saved.length === 1) {
      const [savedOption] = restMatches.saved
      if (!savedOption) {
        setPendingDesktopEnvironmentSetup(null)
        setStatus('Could not resolve the saved desktop environment.', 'error')
        return
      }
      setPendingDesktopEnvironmentSetup(null)
      const selection = await handleSelectRuntimeConfig(savedOption.id, sessionGeneration)
      if (!selection) return
      if (!(await ownsSessionGeneration(selection.sessionGeneration))) return
      authState = getAuthState()
      if (isAuthenticationOperationInProgress(authState) || authState.isAuthenticated) return
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

    if (restMatches.saved.length > 1) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus(
        'Desktop setup link rejected because multiple saved environments use this REST API.',
        'error'
      )
      return
    }

    // The backend supplies the RPC endpoint after the user confirms this REST API.
    if (!(await ownsSessionGeneration(sessionGeneration))) return
    authState = getAuthState()
    if (isAuthenticationOperationInProgress(authState) || authState.isAuthenticated) return
    setPendingDesktopEnvironmentSetup({ ...linkedConfig, rpcProxyBaseUrl: '' })
  }

  return async (payload: DesktopEnvironmentSetupPayload) => {
    if (linkInProgress) {
      setStatus('Another desktop environment link is already being processed.', 'info')
      return
    }
    if (isAuthenticationOperationInProgress(getAuthState())) {
      setStatus(
        'Finish the current authentication action before opening another desktop environment.',
        'info'
      )
      return
    }

    linkInProgress = true
    try {
      await processLink(payload)
    } finally {
      linkInProgress = false
    }
  }
}
