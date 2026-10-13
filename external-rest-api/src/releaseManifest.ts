export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v0.11.0',
  externalRestApiVersion: '0.1.101',
  rpcProxyVersion: '0.1.126',
  desktopVersion: '0.11.0',
}
