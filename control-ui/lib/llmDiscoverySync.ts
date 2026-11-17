import type { LlmDiscoverySyncResult } from './api'
import type { DiscoverySyncDescription, DiscoverySyncNotice } from './llmDiscoverySync.types'

function models(count: number): string {
  return count === 1 ? 'model' : 'models'
}

function wereNot(count: number): string {
  return count === 1 ? 'was not' : 'were not'
}

/**
 * The feedback for a completed catalog sync. The toast stays a success: the run
 * committed. What the run held back goes in a notice, because it asks the
 * operator to run the sync again and must outlive a toast.
 *
 * The branch keys on `decidable`, never on `source`: a live catalog that looks
 * incomplete is just as undecidable as the vendored fallback. A null `decidable`
 * or `outcome` is an older control-api that reported neither, so nothing is
 * claimed about auto-enable.
 */
export function describeDiscoverySync(result: LlmDiscoverySyncResult): DiscoverySyncDescription {
  const { source, added, updated, staled, decidable, outcome } = result
  const decided = decidable === true && outcome ? outcome : null
  const autoEnabled = decided ? decided.autoEnabled : 0
  // Re-enabled rows already existed, so they stay out of "+N new": that count is
  // inserted rows, and the auto-enabled ones are a subset of it.
  const reEnabled = decided ? decided.reEnabled : 0
  const enabledClause = autoEnabled > 0 ? ` (${autoEnabled} enabled automatically)` : ''
  const reEnabledClause = reEnabled > 0 ? `, ${reEnabled} turned back on` : ''
  const catalogHint = autoEnabled + reEnabled > 0 ? ' Enabled models are in the Catalog tab.' : ''
  const toast = `Synced from ${source}: +${added} new${enabledClause}, ${updated} updated, ${staled} marked stale${reEnabledClause}.${catalogHint}`

  let notice: DiscoverySyncNotice | null = null
  if (decidable === false && outcome && outcome.heldUndecidable > 0) {
    const held = outcome.heldUndecidable
    // `source` picks only the explanation: a live catalog below the plausibility
    // floor was reachable, so "once it is reachable" would misdirect.
    const [reason, remedy] =
      source === 'vendored'
        ? ['the live catalog could not be reached', 'run the sync again once it is reachable']
        : ['the live catalog looked incomplete', 'run the sync again']
    notice = {
      tone: 'warn',
      message: `Auto-enable could not decide this run (${reason}): ${held} new ${models(held)} from providers with auto-enable on ${wereNot(held)} added; ${remedy}.`,
    }
  } else if (decided && (decided.deferredByCap > 0 || decided.reEnableDeferredByCap > 0)) {
    const deferred = decided.deferredByCap
    const reDeferred = decided.reEnableDeferredByCap
    const parts = [
      deferred > 0
        ? `${deferred} more new ${models(deferred)} ${wereNot(deferred)} added yet`
        : null,
      reDeferred > 0
        ? `${reDeferred} ${models(reDeferred)} the catalog lists again ${wereNot(reDeferred)} turned back on yet`
        : null,
    ].filter((part): part is string => part !== null)
    notice = {
      tone: 'info',
      message: `${parts.join(' and ')} (auto-enable limit for this run reached); run the sync again to ${reDeferred > 0 ? 'finish' : 'add them'}.`,
    }
  }
  return { toast, notice }
}
