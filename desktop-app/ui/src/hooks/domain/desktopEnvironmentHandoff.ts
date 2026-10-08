import {
  canonicalizeDesktopRestEndpoint,
  desktopRestEndpointOrigin,
  sameDesktopRestEndpoint,
} from '../../../../src/desktopEnvironmentUrl'
import type {
  DesktopRuntimeConfig,
  DesktopRuntimeConfigHandoffSelection,
  DesktopRuntimeConfigOption,
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

function savedEnvironmentsWithDifferentEndpointOnSameOrigin(
  options: DesktopRuntimeConfigState['options'],
  externalRestApiBaseUrl: string
) {
  const restOrigin = desktopRestEndpointOrigin(externalRestApiBaseUrl)
  return options.filter(option => {
    if (option.source === 'localhost' || option.id === LOCALHOST_OPTION_ID) return false
    try {
      return (
        desktopRestEndpointOrigin(option.externalRestApiBaseUrl) === restOrigin &&
        !sameDesktopRestEndpoint(option.externalRestApiBaseUrl, externalRestApiBaseUrl)
      )
    } catch {
      return false
    }
  })
}

function isLocalhostOption(option: DesktopRuntimeConfigState['options'][number]): boolean {
  return option.source === 'localhost' || option.id === LOCALHOST_OPTION_ID
}

function getDesktopEnvironmentRestMatches(
  configState: DesktopRuntimeConfigState,
  externalRestApiBaseUrl: string
) {
  const restOrigin = desktopRestEndpointOrigin(externalRestApiBaseUrl)
  return {
    active: isActiveRestEndpointMatch(configState, externalRestApiBaseUrl),
    localhost: configState.options.find(option => {
      if (!isLocalhostOption(option)) return false
      try {
        return desktopRestEndpointOrigin(option.externalRestApiBaseUrl) === restOrigin
      } catch {
        return false
      }
    }),
    saved: savedEnvironmentsForRestEndpoint(configState.options, externalRestApiBaseUrl),
    sameOriginDifferentEndpoint: savedEnvironmentsWithDifferentEndpointOnSameOrigin(
      configState.options,
      externalRestApiBaseUrl
    ),
  }
}

type DesktopEnvironmentRestMatchDecision =
  | { kind: 'localhost'; option: DesktopRuntimeConfigOption }
  | { kind: 'active' }
  | { kind: 'ambiguous' }
  | { kind: 'saved'; option: DesktopRuntimeConfigOption }
  | { kind: 'path-conflict' }
  | { kind: 'setup' }

export function resolveDesktopEnvironmentRestMatch(
  configState: DesktopRuntimeConfigState,
  externalRestApiBaseUrl: string
): DesktopEnvironmentRestMatchDecision {
  const matches = getDesktopEnvironmentRestMatches(configState, externalRestApiBaseUrl)
  if (matches.localhost) return { kind: 'localhost', option: matches.localhost }
  if (matches.active) return { kind: 'active' }
  if (matches.saved.length > 1) return { kind: 'ambiguous' }
  const [savedOption] = matches.saved
  if (savedOption) return { kind: 'saved', option: savedOption }
  if (matches.sameOriginDifferentEndpoint.length > 0) return { kind: 'path-conflict' }
  return { kind: 'setup' }
}

function isAuthenticationOperationInProgress(state: DesktopEnvironmentHandoffState): boolean {
  return state.booting || state.busy || state.authTransitioning
}

function reportAuthenticationStateChanged(
  state: DesktopEnvironmentHandoffState,
  setStatus: SetStatusFn
): void {
  if (isAuthenticationOperationInProgress(state)) {
    setStatus('Finish the current authentication action, then reopen this desktop link.', 'info')
    return
  }
  setStatus('The desktop session changed while processing this link. Open it again.', 'info')
}

function isActiveRestEndpointMatch(
  configState: DesktopRuntimeConfigState,
  externalRestApiBaseUrl: string
): boolean {
  return Boolean(
    configState.configured &&
    configState.currentConfig &&
    sameDesktopRestEndpoint(
      configState.currentConfig.externalRestApiBaseUrl,
      externalRestApiBaseUrl
    )
  )
}

function rejectSameOriginPathConflict(setStatus: SetStatusFn): void {
  setStatus(
    'Desktop setup link rejected because this REST host is already saved with a different API endpoint.',
    'error'
  )
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
      if ((await getSessionGeneration()) === expectedSessionGeneration) return true
      setStatus('The desktop session changed while processing this link. Open it again.', 'info')
      return false
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
      setStatus('Finish the current authentication action, then reopen this desktop link.', 'info')
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
    let authState = getAuthState()
    if (isAuthenticationOperationInProgress(authState)) {
      reportAuthenticationStateChanged(authState, setStatus)
      return
    }

    let restMatch = resolveDesktopEnvironmentRestMatch(
      configState,
      linkedConfig.externalRestApiBaseUrl
    )
    if (restMatch.kind === 'localhost') {
      setPendingDesktopEnvironmentSetup(null)
      setStatus(
        'Desktop setup link rejected: the Localhost environment cannot be opened from a link.',
        'error'
      )
      return
    }
    authState = getAuthState()
    let activeRestEndpointMatches = restMatch.kind === 'active'
    if (restMatch.kind === 'path-conflict') {
      setPendingDesktopEnvironmentSetup(null)
      rejectSameOriginPathConflict(setStatus)
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
      if (isAuthenticationOperationInProgress(authState) || !authState.isAuthenticated) {
        reportAuthenticationStateChanged(authState, setStatus)
        return
      }

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
          } catch (error) {
            setStatus(
              `Could not reload the current desktop session: ${error instanceof Error ? error.message : String(error)}`,
              'error'
            )
            return
          }
        }
        return
      }
      sessionGeneration = logoutGeneration
      if (!(await ownsSessionGeneration(sessionGeneration))) return

      authState = getAuthState()
      if (isAuthenticationOperationInProgress(authState)) {
        reportAuthenticationStateChanged(authState, setStatus)
        return
      }
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
        if (authState.isAuthenticated) {
          reportAuthenticationStateChanged(authState, setStatus)
          return
        }
      }
      try {
        configState = await refreshRuntimeConfigState()
      } catch {
        setStatus('Could not verify the desktop environment. Try opening it again.', 'error')
        return
      }
      if (!(await ownsSessionGeneration(sessionGeneration))) return
      authState = getAuthState()
      if (isAuthenticationOperationInProgress(authState) || authState.isAuthenticated) {
        reportAuthenticationStateChanged(authState, setStatus)
        return
      }
      restMatch = resolveDesktopEnvironmentRestMatch(
        configState,
        linkedConfig.externalRestApiBaseUrl
      )
      if (restMatch.kind === 'localhost') {
        setPendingDesktopEnvironmentSetup(null)
        setStatus(
          'Desktop setup link rejected: the Localhost environment cannot be opened from a link.',
          'error'
        )
        return
      }
      activeRestEndpointMatches = restMatch.kind === 'active'
      if (restMatch.kind === 'path-conflict') {
        setPendingDesktopEnvironmentSetup(null)
        rejectSameOriginPathConflict(setStatus)
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
    }

    if (authState.isAuthenticated) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus('This link points to the active Evenfire Desktop environment.', 'success')
      return
    }

    if (activeRestEndpointMatches) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus('This link points to the active Evenfire Desktop environment.', 'success')
      return
    }

    if (restMatch.kind === 'saved') {
      const savedOption = restMatch.option
      setPendingDesktopEnvironmentSetup(null)
      const selection = await handleSelectRuntimeConfig(savedOption.id, sessionGeneration)
      if (!selection) return
      if (!(await ownsSessionGeneration(selection.sessionGeneration))) return
      authState = getAuthState()
      if (isAuthenticationOperationInProgress(authState) || authState.isAuthenticated) {
        reportAuthenticationStateChanged(authState, setStatus)
        return
      }
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

    // The backend supplies the RPC endpoint after the user confirms this REST API.
    if (!(await ownsSessionGeneration(sessionGeneration))) return
    authState = getAuthState()
    if (isAuthenticationOperationInProgress(authState) || authState.isAuthenticated) {
      reportAuthenticationStateChanged(authState, setStatus)
      return
    }
    setPendingDesktopEnvironmentSetup({ ...linkedConfig, rpcProxyBaseUrl: '' })
  }

  return async (payload: DesktopEnvironmentSetupPayload) => {
    if (linkInProgress) {
      setStatus('Another desktop environment link is already being processed.', 'info')
      return
    }
    if (isAuthenticationOperationInProgress(getAuthState())) {
      setStatus('Finish the current authentication action, then reopen this desktop link.', 'info')
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
