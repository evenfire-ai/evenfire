/**
 * T3.1 — Session search public surface. Used by the native tool, the REST
 * handler, and the boot-time retention sweep in `main.ts`.
 */
export type { SessionSearchArgs, SessionSearchResult, SessionSearchResultItem } from './types'
export {
  SessionSearchService,
  sessionSearchCallsCounter,
  sessionSearchLatency,
  sessionSearchResults,
  sessionSearchRetentionSweep,
  sessionSearchUnauthorizedAttempts,
} from './service'
export type { SessionSearchServiceDeps } from './service'
