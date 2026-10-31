export type UserHomeConflictCode =
  | 'path_conflict'
  | 'ancestor_grant_conflict'
  | 'ownership_conflict'

export type UserHomeConflictDetail = {
  resourceIds: string[]
  grantIds?: string[]
  shareIds?: string[]
}

/** D22 allows IDs only; reject other keys or values before persistence or logging. */
export function parseUserHomeConflictDetail(value: unknown): UserHomeConflictDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid user-home conflict detail')
  }
  const detail = value as Record<string, unknown>
  const allowed = new Set(['resourceIds', 'grantIds', 'shareIds'])
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (
    !Object.keys(detail).every(key => allowed.has(key)) ||
    !Object.hasOwn(detail, 'resourceIds') ||
    !Object.values(detail).every(
      ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && uuid.test(id))
    )
  ) {
    throw new Error('Invalid user-home conflict detail')
  }
  return detail as UserHomeConflictDetail
}

export type UserHomeState = {
  state: 'pending' | 'ready' | 'conflict' | 'retired'
  drive: string | null
  conflictCode: UserHomeConflictCode | null
  conflictDetail: unknown | null
}

export type UserHomeTransition =
  | { type: 'provisioned'; drive: string }
  | { type: 'conflict'; drive: string; code: UserHomeConflictCode; detail: unknown }
  | { type: 'retry' }
  | { type: 'restore-owner' }
  | { type: 'owner-grant-lost'; detail: unknown }
  | { type: 'retire' }

/** State policy shared with the later retirement and operator-route slices. */
export function transitionUserHomeState(
  current: UserHomeState,
  transition: UserHomeTransition
): UserHomeState {
  switch (transition.type) {
    case 'provisioned':
      if (current.state === 'pending') {
        return { state: 'ready', drive: transition.drive, conflictCode: null, conflictDetail: null }
      }
      break
    case 'conflict':
      if (current.state === 'pending') {
        return {
          state: 'conflict',
          drive: transition.drive,
          conflictCode: transition.code,
          conflictDetail: parseUserHomeConflictDetail(transition.detail),
        }
      }
      break
    case 'retry':
      if (
        current.state === 'conflict' &&
        (current.conflictCode === 'path_conflict' ||
          current.conflictCode === 'ancestor_grant_conflict')
      ) {
        return { ...current, state: 'pending', conflictCode: null, conflictDetail: null }
      }
      break
    case 'restore-owner':
      if (current.state === 'conflict' && current.conflictCode === 'ownership_conflict') {
        return { ...current, state: 'ready', conflictCode: null, conflictDetail: null }
      }
      break
    case 'owner-grant-lost':
      if (current.state === 'ready') {
        return {
          ...current,
          state: 'conflict',
          conflictCode: 'ownership_conflict',
          conflictDetail: parseUserHomeConflictDetail(transition.detail),
        }
      }
      break
    case 'retire':
      if (
        current.state === 'pending' ||
        current.state === 'ready' ||
        current.state === 'conflict'
      ) {
        return { ...current, state: 'retired', conflictCode: null, conflictDetail: null }
      }
      break
  }
  throw new Error(`Invalid user-home transition: ${current.state} -> ${transition.type}`)
}
