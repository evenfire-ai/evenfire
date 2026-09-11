import { createHash } from 'crypto'

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * sha256 of the mirror Secret's base64 credential. Rotating the credential
 * changes this digest → pod template annotation → rolling restart onto the new
 * key.
 */
export function credentialsRevision(credentialB64: string): string {
  return sha256(credentialB64)
}

/** Both pod-template revisions derived from the broker's desired state. */
export type BrokerRevisions = { configRevision: string; credentialsRevision: string }

/**
 * The two pod-template revision digests for a broker:
 *  - configRevision: sha256 of the FULL rendered nginx ConfigMap template. It is
 *    exactly what the pod consumes, so it covers ip/port/scheme/path AND any
 *    future nginx-template change. Editing only ip/port (the ConfigMap) leaves the
 *    Deployment byte-identical, so without this the pod never rolls onto the new
 *    upstream and keeps dialing the IP the new /32 NetworkPolicy now blocks.
 *  - credentialsRevision: sha256 of the base64 credential (rotation).
 * The render never contains the secret (only the ${...} placeholder), so hashing
 * it leaks nothing.
 */
export function brokerRevisions(nginxConf: string, credentialB64: string): BrokerRevisions {
  return { configRevision: sha256(nginxConf), credentialsRevision: sha256(credentialB64) }
}
