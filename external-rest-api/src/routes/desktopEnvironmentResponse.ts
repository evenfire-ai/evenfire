export type DesktopEnvironmentConfig = {
  desktopAppName: string
  publicBaseUrl: string
  desktopRpcProxyBaseUrl: string
}

export type DesktopEnvironmentResponse = {
  appName: string
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
}

export function buildDesktopEnvironmentResponse(
  config: DesktopEnvironmentConfig
): DesktopEnvironmentResponse {
  return {
    appName: config.desktopAppName,
    externalRestApiBaseUrl: config.publicBaseUrl,
    rpcProxyBaseUrl: config.desktopRpcProxyBaseUrl,
  }
}
