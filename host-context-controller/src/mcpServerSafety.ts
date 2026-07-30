import type { McpServerCRD } from './types'
import { getErrorCode } from './utils'

const NETWORK_READY_ANNOTATION = 'clerum.io/network-ready'

/**
 * This acknowledgement is written by HCC after it has applied a server's
 * NetworkPolicies so WRC can admit its workload. It is not user intent and it
 * cannot change any NetworkPolicy decision. Treating that write as desired
 * state makes HCC invalidate its own authoritative revocation pass under a
 * large startup fleet, coupling /ready to additive runtime convergence again.
 */
function desiredAnnotations(annotations: Record<string, string> | undefined): Record<string, string> {
  if (!annotations?.[NETWORK_READY_ANNOTATION]) return annotations ?? {}
  const { [NETWORK_READY_ANNOTATION]: _networkReady, ...remaining } = annotations
  return remaining
}

export function sameMcpServerDesiredRevision(
  expected: McpServerCRD,
  current: McpServerCRD
): boolean {
  if (expected.name !== current.name || expected.namespace !== current.namespace) return false
  if (expected.uid && current.uid && expected.uid !== current.uid) return false
  if (
    expected.generation !== undefined &&
    current.generation !== undefined &&
    expected.generation !== current.generation
  ) {
    return false
  }

  return (
    JSON.stringify(expected.spec) === JSON.stringify(current.spec) &&
    JSON.stringify(desiredAnnotations(expected.annotations)) ===
      JSON.stringify(desiredAnnotations(current.annotations)) &&
    JSON.stringify(expected.labels ?? {}) === JSON.stringify(current.labels ?? {})
  )
}

export function isMcpServerStatusOnlyUpdate(
  previous: McpServerCRD,
  current: McpServerCRD
): boolean {
  return (
    previous.uid === current.uid &&
    previous.generation === current.generation &&
    sameMcpServerDesiredRevision(previous, current)
  )
}

export interface AuthoritativeMcpServerAbsenceCheck {
  inventoryAuthoritative: () => boolean
  resolveCurrent: () => McpServerCRD | undefined
  readCurrent: () => Promise<unknown>
}

export async function confirmAuthoritativeMcpServerAbsence({
  inventoryAuthoritative,
  resolveCurrent,
  readCurrent,
}: AuthoritativeMcpServerAbsenceCheck): Promise<boolean> {
  if (!inventoryAuthoritative() || resolveCurrent()) return false

  try {
    await readCurrent()
    return false
  } catch (error: unknown) {
    if (getErrorCode(error) !== 404) throw error
  }

  return inventoryAuthoritative() && !resolveCurrent()
}
