import { createHash } from 'node:crypto'

export function scopedLogicalId(namespace: string, name: string): string {
  return `${namespace}/${name}`
}

export function sharedFilesystemScopeRef(input: {
  contextLogicalId: string
  filesystemLogicalId: string
  mountPath: string
}): string {
  const fingerprint = createHash('sha256')
    .update(`${input.contextLogicalId}\u0000${input.filesystemLogicalId}\u0000${input.mountPath}`)
    .digest('base64url')
  return `sfs-scope:${fingerprint}`
}
