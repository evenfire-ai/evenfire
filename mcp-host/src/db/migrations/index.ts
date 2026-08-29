import * as initial from './001-initial-schema'
import * as activeTaskId from './002-active-task-id'
import * as sessionsStateIndex from './003-sessions-state-index'
import * as awaitingApprovalIndex from './004-sessions-awaiting-approval-index'
import * as messagesTokenUsage from './005-messages-token-usage'
import * as sessionsCacheReported from './006-sessions-cache-reported'
import * as sessionsModelSelections from './007-sessions-model-selections'
import * as activeTraceContext from './008-active-trace-context'
import * as sessionSummaryIndexes from './009-session-summary-indexes'
import * as materializedSessionSummaries from './010-materialized-session-summaries'
import * as sessionSummaryUserActivityIndex from './011-session-summary-user-activity-index'
import * as sessionOwnershipBackfill from './012-session-ownership-backfill'
import * as messagesGuardrailActivity from './013-messages-guardrail-activity'

/**
 * Ordered list of migrations. New migrations append; never reorder or rename.
 * The runner (`src/db/migrate.ts`) executes `up()` in order and records each
 * applied name in the `migrations_meta` table.
 */
export const migrations: Array<{
  name: string
  up: typeof initial.up
  down: typeof initial.down
}> = [
  initial,
  activeTaskId,
  sessionsStateIndex,
  awaitingApprovalIndex,
  messagesTokenUsage,
  sessionsCacheReported,
  sessionsModelSelections,
  activeTraceContext,
  sessionSummaryIndexes,
  materializedSessionSummaries,
  sessionSummaryUserActivityIndex,
  sessionOwnershipBackfill,
  messagesGuardrailActivity,
]
