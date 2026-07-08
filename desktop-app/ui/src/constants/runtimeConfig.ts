import type { DesktopRuntimeConfigOption } from '../../../src/types'

export const LOCALHOST_RUNTIME_CONFIG_OPTION_ID = '__localhost__'

export function createLocalhostRuntimeConfigOption(): DesktopRuntimeConfigOption {
  return {
    id: LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
    label: 'Localhost',
    source: 'localhost',
    configPath: null,
    externalRestApiBaseUrl: 'http://127.0.0.1:8091',
    rpcProxyBaseUrl: 'http://127.0.0.1:8094',
    appName: 'Localhost',
  }
}
