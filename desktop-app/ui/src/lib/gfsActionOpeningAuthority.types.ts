export interface GfsActionOpeningTarget {
  resourceId: string
  name: string
  parentResourceId?: string | null
}

/**
 * What must be proven before an action's editor opens. `check`: these bits
 * on that resource, named so in the denial toast. `unverifiable`: the
 * resource the check needs is unknown, or the action has no known opening
 * authority, so the action cannot open.
 */
export type GfsActionOpeningAuthority =
  | { kind: 'check'; resourceId: string; resourceName: string; bits: readonly string[] }
  | { kind: 'unverifiable'; message: string }
