import {
  canonicalizeDesktopRestEndpoint,
  desktopRestEndpointOrigin,
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
  rpcProxyBaseUrl?: string
  appName?: string
}

type DesktopEnvironmentSetupHandlerOptions = {
  getAuthState: () => DesktopEnvironmentHandoffState
  refreshRuntimeConfigState: () => Promise<DesktopRuntimeConfigState>
  handleSelectRuntimeConfig: (optionId: string) => Promise<DesktopRuntimeConfigState | null>
  onSessionNeedsLoad: (options?: { preserveNav?: boolean }) => Promise<void>
  setPendingDesktopEnvironmentSetup: (config: DesktopRuntimeConfig | null) => void
  setStatus: SetStatusFn
}

function environmentOrigin(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) desktop environment URLs are supported')
  }
  return url.origin
}

function sameDesktopEnvironment(
  left: Pick<DesktopRuntimeConfig, 'externalRestApiBaseUrl' | 'rpcProxyBaseUrl'>,
  right: Pick<DesktopRuntimeConfig, 'externalRestApiBaseUrl' | 'rpcProxyBaseUrl'>
): boolean {
  try {
    return (
      desktopRestEndpointOrigin(left.externalRestApiBaseUrl) ===
        desktopRestEndpointOrigin(right.externalRestApiBaseUrl) &&
      (left.rpcProxyBaseUrl?.trim() ? environmentOrigin(left.rpcProxyBaseUrl) : '') ===
        (right.rpcProxyBaseUrl?.trim() ? environmentOrigin(right.rpcProxyBaseUrl) : '')
    )
  } catch {
    return false
  }
}

function savedEnvironmentsForRestOrigin(
  options: DesktopRuntimeConfigState['options'],
  restOrigin: string
) {
  return options.filter(option => {
    if (option.source === 'localhost' || option.id === LOCALHOST_OPTION_ID) return false
    try {
      return desktopRestEndpointOrigin(option.externalRestApiBaseUrl) === restOrigin
    } catch {
      return false
    }
  })
}

function isLocalhostOption(option: DesktopRuntimeConfigState['options'][number]): boolean {
  return option.source === 'localhost' || option.id === LOCALHOST_OPTION_ID
}

export function getDesktopEnvironmentRestOriginMatches(
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
    saved: savedEnvironmentsForRestOrigin(configState.options, restOrigin),
  }
}

type SavedEnvironmentDecision =
  | { kind: 'select'; option: DesktopRuntimeConfigState['options'][number] }
  | { kind: 'setup' }
  | { kind: 'reject'; reason: 'ambiguous' | 'rpc-conflict' }

function decideSavedEnvironment(
  sameRestOrigin: DesktopRuntimeConfigState['options'],
  linkedConfig: DesktopRuntimeConfig
): SavedEnvironmentDecision {
  const linkedRpcOrigin = linkedConfig.rpcProxyBaseUrl?.trim()
    ? environmentOrigin(linkedConfig.rpcProxyBaseUrl)
    : ''

  if (!linkedRpcOrigin) {
    if (sameRestOrigin.length > 1) return { kind: 'reject', reason: 'ambiguous' }
    if (sameRestOrigin.length === 1) return { kind: 'select', option: sameRestOrigin[0] }
    return { kind: 'setup' }
  }

  const exactMatch = sameRestOrigin.find(option => {
    try {
      return environmentOrigin(option.rpcProxyBaseUrl) === linkedRpcOrigin
    } catch {
      return false
    }
  })
  if (exactMatch) return { kind: 'select', option: exactMatch }
  if (sameRestOrigin.length) return { kind: 'reject', reason: 'rpc-conflict' }
  return { kind: 'setup' }
}

function isAuthenticationOperationInProgress(state: DesktopEnvironmentHandoffState): boolean {
  return state.booting || state.busy || state.authTransitioning
}

export function createDesktopEnvironmentSetupHandler({
  getAuthState,
  refreshRuntimeConfigState,
  handleSelectRuntimeConfig,
  onSessionNeedsLoad,
  setPendingDesktopEnvironmentSetup,
  setStatus,
}: DesktopEnvironmentSetupHandlerOptions) {
  let linkInProgress = false

  const processLink = async ({
    externalRestApiBaseUrl,
    rpcProxyBaseUrl,
    appName,
  }: DesktopEnvironmentSetupPayload) => {
    const normalizedExternalRestApiBaseUrl = externalRestApiBaseUrl.trim()
    if (!normalizedExternalRestApiBaseUrl) return
    const linkedConfig: DesktopRuntimeConfig = {
      externalRestApiBaseUrl: normalizedExternalRestApiBaseUrl,
      rpcProxyBaseUrl: rpcProxyBaseUrl?.trim() || '',
      appName: appName?.trim() || 'Evenfire',
    }
    try {
      linkedConfig.externalRestApiBaseUrl = canonicalizeDesktopRestEndpoint(
        linkedConfig.externalRestApiBaseUrl
      )
      if (linkedConfig.rpcProxyBaseUrl) environmentOrigin(linkedConfig.rpcProxyBaseUrl)
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

    const restOriginMatches = getDesktopEnvironmentRestOriginMatches(
      configState,
      linkedConfig.externalRestApiBaseUrl
    )
    if (restOriginMatches.localhost) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus(
        'Desktop setup link rejected: the Localhost environment cannot be opened from a link.',
        'error'
      )
      return
    }

    const savedDecision = decideSavedEnvironment(restOriginMatches.saved, linkedConfig)
    const activeEnvironmentMatches = Boolean(
      configState.configured &&
      configState.currentConfig &&
      (sameDesktopEnvironment(configState.currentConfig, linkedConfig) ||
        (savedDecision.kind === 'select' && savedDecision.option.id === configState.activeOptionId))
    )
    if (activeEnvironmentMatches) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus(`Opening ${linkedConfig.appName} in Evenfire Desktop.`, 'success')
      return
    }

    if (getAuthState().isAuthenticated) {
      setPendingDesktopEnvironmentSetup(null)
      setStatus('Sign out before opening another desktop environment.', 'info')
      return
    }

    if (savedDecision.kind === 'select') {
      setPendingDesktopEnvironmentSetup(null)
      const selectedState = await handleSelectRuntimeConfig(savedDecision.option.id)
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

    if (savedDecision.kind === 'reject') {
      setPendingDesktopEnvironmentSetup(null)
      setStatus(
        savedDecision.reason === 'ambiguous'
          ? 'Desktop setup link rejected because multiple saved environments use this REST host.'
          : 'Desktop setup link rejected because its RPC proxy does not match the saved environment.',
        'error'
      )
      return
    }

    // The RPC URL in an external link is untrusted. Desktop discovers it from
    // the selected REST endpoint after confirmation.
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
