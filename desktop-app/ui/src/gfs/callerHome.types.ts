/**
 * The caller's own home as the browser controller reports it. `state` decides
 * usability: only a `ready` home is a browsable root or a move destination.
 */
export type GfsCallerHome = {
  state: string
  drive: string | null
  resourceId: string | null
  path: string | null
} | null
