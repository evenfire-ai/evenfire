import type { McpServerCRD } from './types'
import { getErrorCode } from './utils'

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
    JSON.stringify(expected.annotations ?? {}) === JSON.stringify(current.annotations ?? {}) &&
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
