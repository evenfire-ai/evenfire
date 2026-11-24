export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.12.1',
  externalRestApiVersion: '0.1.204',
  rpcProxyVersion: '0.1.159',
  desktopVersion: '0.12.1',
  minimumDesktopVersion: '0.1.252',
}
