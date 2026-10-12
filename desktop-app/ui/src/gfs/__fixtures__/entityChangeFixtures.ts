import type { EntityChangeStreamEvent } from '../../../../src/types.js'

/** The fixed-cadence frame emitted by the authenticated Desktop user stream. */
export const USER_SCOPE_INVALIDATED = {
  schemaVersion: 1,
  type: 'scope.invalidated',
  cursor: '00000000-0000-0000-0000-000000000000',
  scopes: ['gfs', 'authorization'],
} satisfies Extract<EntityChangeStreamEvent, { type: 'scope.invalidated' }>
