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

/**
 * What EvenDrive says about a home that is not ready: one notice shared by the
 * sidebar and the Files page. `text` is the sentence shown for that state, or
 * the presented error message when the home could not be loaded.
 */
export type GfsHomeNotice = { kind: 'pending' | 'conflict' | 'error'; text: string }
