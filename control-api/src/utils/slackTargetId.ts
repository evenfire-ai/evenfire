const TARGET_PREFIX = 'slack:'
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const K8S_NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_TARGET_ID_BASE64URL_CHARS = 1024
const MAX_TARGET_ID_JSON_BYTES = 512

export type SlackTargetIdParts = {
  namespace: string
  name: string
}

export function encodeSlackTargetId(namespace: string, name: string): string {
  return `${TARGET_PREFIX}${Buffer.from(JSON.stringify({ namespace, name })).toString('base64url')}`
}

export function decodeSlackTargetId(targetId: string): SlackTargetIdParts {
  if (!targetId.startsWith(TARGET_PREFIX)) throw new Error('invalid_target_id')
  try {
    const payload = targetId.slice(TARGET_PREFIX.length)
    if (payload.length > MAX_TARGET_ID_BASE64URL_CHARS) throw new Error('invalid_target_id')
    const decoded = Buffer.from(payload, 'base64url')
    if (decoded.byteLength > MAX_TARGET_ID_JSON_BYTES) throw new Error('invalid_target_id')
    const parsed = JSON.parse(decoded.toString('utf8')) as {
      namespace?: unknown
      name?: unknown
    }
    const namespace = String(parsed.namespace || '').trim()
    const name = String(parsed.name || '').trim()
    if (!K8S_NAMESPACE_RE.test(namespace) || !K8S_NAME_RE.test(name)) {
      throw new Error('invalid_target_id')
    }
    return { namespace, name }
  } catch {
    throw new Error('invalid_target_id')
  }
}

export function tryDecodeSlackTargetId(targetId: string): SlackTargetIdParts | null {
  try {
    return decodeSlackTargetId(targetId)
  } catch {
    return null
  }
}
