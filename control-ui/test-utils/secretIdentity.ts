export type SecretIdentity = {
  uid: string
  resourceVersion: string
}

export function requireSecretIdentity(value: unknown, operation: string): SecretIdentity {
  const record = value as { uid?: unknown; resourceVersion?: unknown }
  if (
    typeof record?.uid !== 'string' ||
    !record.uid.trim() ||
    typeof record.resourceVersion !== 'string' ||
    !record.resourceVersion.trim()
  ) {
    throw new Error(`${operation} did not return a complete object identity`)
  }
  return { uid: record.uid, resourceVersion: record.resourceVersion }
}
