import type { EmbedFailure, ViewRecord } from './embedOwnership.types'

/** What the embed slot of the active app tab shows. */
export type EmbedViewState =
  /** No launch owns the tab and nothing failed: the app picker. */
  | { kind: 'idle' }
  /** The owner is on its way to main (waiting, measuring or opening). */
  | { kind: 'minting'; launch: ViewRecord }
  | { kind: 'mounted'; launch: ViewRecord }
  /** The tab's last launch failed or its view crashed. */
  | { kind: 'failed'; failure: EmbedFailure }
