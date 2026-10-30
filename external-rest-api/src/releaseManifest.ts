export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.12.0',
  externalRestApiVersion: '0.1.161',
  rpcProxyVersion: '0.1.138',
  desktopVersion: '0.12.0',
  minimumDesktopVersion: '0.1.252',
}
