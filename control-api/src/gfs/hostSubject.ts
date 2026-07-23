export type HostSubjectParty = '1st' | '3rd'

const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_K8S_NAME_LENGTH = 63

function isK8sName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_K8S_NAME_LENGTH && K8S_NAME_RE.test(value)
}

export function isValidHostSubjectId(value: string): boolean {
  const match = /^(1st|3rd):([^/]+)\/([^/]+)$/.exec(value)
  if (!match) return false
  return isK8sName(match[2] ?? '') && isK8sName(match[3] ?? '')
}

export function makeHostSubjectId(
  party: HostSubjectParty,
  namespace: string,
  name: string
): string | null {
  if (!isK8sName(namespace) || !isK8sName(name)) return null
  return `${party}:${namespace}/${name}`
}
