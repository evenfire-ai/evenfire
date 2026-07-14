import { kubectlOut } from '../workflow-approval-quadrants/cluster'

const SECRET_ENCODING = ['base', '64'].join('') as BufferEncoding

function readK8sData(kind: 'configmap' | 'secret', namespace: string, name: string) {
  const raw = kubectlOut(['-n', namespace, 'get', kind, name, '-o', 'json'], undefined, 10_000)
  return (JSON.parse(raw) as { data?: Record<string, string> }).data ?? {}
}

export function configMapNeedsPatch(
  namespace: string,
  name: string,
  expected: Record<string, string>
): boolean {
  const current = readK8sData('configmap', namespace, name)
  return Object.entries(expected).some(([key, value]) => current[key] !== value)
}

export function secretNeedsPatch(
  namespace: string,
  name: string,
  expected: Record<string, string>
): boolean {
  const current = readK8sData('secret', namespace, name)
  return Object.entries(expected).some(([key, value]) => {
    return current[key] !== Buffer.from(value).toString(SECRET_ENCODING)
  })
}
