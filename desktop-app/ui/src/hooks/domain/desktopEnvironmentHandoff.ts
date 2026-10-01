import {
  canonicalizeDesktopRestEndpoint,
  desktopRestEndpointOrigin,
  sameDesktopRestEndpoint,
} from '../../../../src/desktopEnvironmentUrl'
import type { DesktopRuntimeConfig, DesktopRuntimeConfigState } from '../../../../src/types'
import type { SetStatusFn } from './types'

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
  refreshRuntimeConfigState: () => Promise<DesktopRuntimeConfigState>
  handleSelectRuntimeConfig: (optionId: string) => Promise<DesktopRuntimeConfigState | null>
  onSessionNeedsLoad: (options?: { preserveNav?: boolean }) => Promise<void>
  logoutForEnvironmentMismatch: () => Promise<void>
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
  refreshRuntimeConfigState,
  handleSelectRuntimeConfig,
  onSessionNeedsLoad,
  logoutForEnvironmentMismatch,
  setPendingDesktopEnvironmentSetup,
  setStatus,
}: DesktopEnvironmentSetupHandlerOptions) {
  let linkInProgress = false

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

    let configState: DesktopRuntimeConfigState
    try {
      configState = await refreshRuntimeConfigState()
    } catch {
      setStatus('Could not verify the desktop environment. Try opening it again.', 'error')
      return
    }

    if (isAuthenticationOperationInProgress(getAuthState())) {
      setStatus(
        'Finish the current authentication action before opening another desktop environment.',
        'info'
      )
      return
    }

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
      setPendingDesktopEnvironmentSetup(null)
      try {
        await logoutForEnvironmentMismatch()
      } catch (error) {
        setStatus(
          `Could not sign out before switching desktop environments: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
        return
      }
      authState = getAuthState()
      if (authState.isAuthenticated) {
        try {
          await onSessionNeedsLoad({ preserveNav: true })
        } catch {
          authState = getAuthState()
          if (authState.isAuthenticated) {
            setStatus(
              'Could not verify your sign-in state before switching desktop environments.',
              'error'
            )
            return
          }
        }
        authState = getAuthState()
        if (authState.isAuthenticated) return
      }
      try {
        configState = await refreshRuntimeConfigState()
      } catch {
        setStatus('Could not verify the desktop environment. Try opening it again.', 'error')
        return
      }
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
      setPendingDesktopEnvironmentSetup(null)
      const selectedState = await handleSelectRuntimeConfig(restMatches.saved[0].id)
      if (!selectedState) return
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
