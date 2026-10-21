export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.11.0',
  externalRestApiVersion: '0.1.143',
  rpcProxyVersion: '0.1.132',
  desktopVersion: '0.11.0',
  minimumDesktopVersion: '0.1.252',
}
