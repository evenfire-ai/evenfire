export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.8.0',
  externalRestApiVersion: '0.1.81',
  rpcProxyVersion: '0.1.72',
  desktopVersion: '0.8.0',
  minimumDesktopVersion: '0.1.252',
}
