export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'dev-fe20a73f',
  externalRestApiVersion: '0.1.61',
  rpcProxyVersion: '0.1.62',
  desktopVersion: '0.5.1',
  minimumDesktopVersion: '0.1.252',
}
