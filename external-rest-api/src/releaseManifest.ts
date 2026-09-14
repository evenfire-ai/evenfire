export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.8.0',
  externalRestApiVersion: '0.1.107',
  rpcProxyVersion: '0.1.85',
  desktopVersion: '0.8.0',
  minimumDesktopVersion: '0.1.252',
}
