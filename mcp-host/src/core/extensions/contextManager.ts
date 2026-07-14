/**
 * PressureContextManager and InLoopContextManager - ContextManager implementations.
 *
 * Phase 6: Context window pressure management for the tool-use loop.
 *
 * PressureContextManager uses tiered compaction based on token usage:
 *   < 80%:  passthrough (no compaction)
 *   80-85%: MoveToWorkspace — archive old turns to daily log, keep 8
 *   85-95%: Summarize — LLM-summarize old turns to daily log, keep 5
 *   > 95%:  Truncate — emergency drop, keep 3 (no LLM call)
 *
 * InLoopContextManager is a simpler version with a single threshold.
 */
import { Counter, Histogram } from 'prom-client'
import type { Workspace } from '../../workspace/service'
import {
  applyAlignedCut,
  estimateTokens,
  measureCompactionRatio,
  splitTurns,
  turnIndexToMessageIndex,
} from '../conversation/compaction'
import { parseStructuredSummary } from '../conversation/structuredSummaryParser'
import { ContextManageOptions, ContextManager, LlmPort } from '../interfaces'
import type { AgentEventEmitter } from '../interfaces'
import { validateToolLinkages } from '../orchestration/toolUseLoop'
import { tokenizerDryrunDelta, tokenizerDryrunTierMismatchTotal } from '../tokenizer/metrics'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import { ChatMessage, CompactionState, Conversation } from '../types'
import { type PrePruneOptions, clerumPrePruneSavingsTokensTotal, prePrune } from './prePrune'
import { buildStructuredSummaryPrompt } from './structuredSummaryTemplate'

// ─── T1.4 Prometheus instruments ────────────────────────────────────────────
//
// Co-located with the manager (same pattern as `tokenizer/metrics.ts`'s
// `tokenizerFallbackTotal`). The `skipped:pending_approval` outcome is emitted
// by `runToolUseLoop` (P.3 §4.1 — single source of truth); the manager only
// emits `ok` and `thrashing`. The histogram is observed once per *actual*
// compaction (i.e. not on passthrough, defensive-skip or thrash backoff).

// `none` is the sentinel for the `skipped:pending_approval` outcome which is
// emitted by `runToolUseLoop` before any tier is chosen (P.3 §4.1).
export type CompactionTier = 'move_to_workspace' | 'summarize' | 'truncate' | 'none'
export type CompactionOutcome = 'ok' | 'thrashing' | 'skipped:pending_approval'

export const clerumCompactionTotal = new Counter({
  name: 'clerum_compaction_total',
  help: 'Compaction attempts by tier and outcome.',
  labelNames: ['tier', 'outcome'] as const,
})

export const clerumCompactionRatio = new Histogram({
  name: 'clerum_compaction_ratio',
  help: 'post/pre token ratio per compaction attempt (lower is more effective).',
  buckets: [0.1, 0.25, 0.5, 0.7, 0.8, 0.9, 0.95, 1.0],
})

// ─── T1.1 — Structured summary parse outcome counter ────────────────────────
//
// Tracked only when `CLERUM_COMPACTION_STRUCTURED_SUMMARY=true` AND the
// summarize tier ran. Labels mirror `ParseStatus` so the bake-week dashboards
// can flag "≥ 80% ok" before flipping the default in prod.
export const clerumCompactionStructuredParseTotal = new Counter({
  name: 'clerum_compaction_structured_parse_total',
  help: 'Structured summary parse outcomes per Summarize tier invocation.',
  labelNames: ['outcome'] as const,
})

export interface PressureContextManagerOptions {
  /**
   * P.2 dry-run mode. When true (the default during the bake-week), the
   * manager uses the legacy heuristic to decide the tier and ALSO computes
   * the real counter value for observability. When false, the real counter
   * drives the decision. See `.specs/mcp-hermes/implementation-plans/P2-tokenizer.md`.
   */
  dryRun?: boolean
  /**
   * T1.4 — Anti-thrash thresholds. Two consecutive compactions whose
   * `post/pre` token ratio exceeds `ineffectiveRatio` trip a backoff: the
   * manager stops attempting compaction for the rest of the task and lets
   * the agent-level budgets terminate the loop.
   *
   * Defaults: `ineffectiveRatio=0.9`, `ineffectiveMaxRun=2`.
   */
  ineffectiveRatio?: number
  ineffectiveMaxRun?: number
  /**
   * T1.4 — Optional event emitter for the one-shot `compaction:thrashing`
   * activity event. When omitted, the event is dropped silently and only the
   * Prometheus counter records the outcome (useful for unit tests).
   */
  events?: AgentEventEmitter
  /**
   * T1.4 — Optional task id stamped onto the thrashing event so the activity
   * hub can correlate the event with the originating task.
   */
  taskId?: string
  /**
   * T1.2 — Master flag for the deterministic pre-prune. Default `false`.
   * When `true`, `manage()` runs the four-pass pre-prune after the pressure
   * threshold is crossed but before any tier is selected; if pre-prune alone
   * brings pressure back under 80%, the manager returns the pruned set
   * without invoking the tier.
   */
  prePruneEnabled?: boolean
  /**
   * T1.2 — Per-pass toggles + budgets. Defaults documented in
   * `DEFAULT_PRE_PRUNE_OPTIONS`. Only consulted when `prePruneEnabled === true`.
   */
  prePruneOptions?: PrePruneOptions
  /**
   * T1.1 — Structured summary template. When `true`, the `Summarize` tier
   * sends the section-anchored prompt (defensive preamble + Active Task +
   * Memory Writes) and parses the LLM output via `parseStructuredSummary`.
   * When `false` (the default during rollout), behaves bit-for-bit like the
   * pre-T1.1 free-form summarizer. See `structuredSummaryTemplate.ts`.
   */
  structuredSummaryEnabled?: boolean

  /**
   * T2.2 — invalidation hook fired AFTER a real compaction (any tier that
   * archived turns). The manager has no direct dependency on `PromptCache`;
   * the wiring side (`TaskExecutor.buildLoopConfig`) passes a closure that
   * captures the cache + sessionKey so the manager stays free of LLM-adapter
   * concerns.
   */
  onCompactionEffective?: (info: { conversationId: string; tier: CompactionTier }) => void
}

type PressureTier = 'passthrough' | 'workspace' | 'summarize' | 'truncate'

function tierFor(pressure: number): PressureTier {
  if (pressure < 0.8) return 'passthrough'
  if (pressure < 0.85) return 'workspace'
  if (pressure < 0.95) return 'summarize'
  return 'truncate'
}

/**
 * T1.4 — translate a numeric pressure into the Counter `tier` label. Distinct
 * from `tierFor`/`PressureTier` because the metric uses snake-case labels
 * matching the activity-hub vocabulary (`move_to_workspace` vs. `workspace`).
 */
function tierLabel(pressure: number): CompactionTier {
  if (pressure >= 0.95) return 'truncate'
  if (pressure >= 0.85) return 'summarize'
  return 'move_to_workspace'
}

/**
 * T1.4 — lazily attach a fresh `CompactionState` to the conversation. Mutates
 * the input so subsequent calls within the same task share the counter.
 */
function ensureCompactionState(conv: Conversation): CompactionState {
  if (!conv.compactionState) {
    conv.compactionState = {
      lastRatio: 1.0,
      ineffectiveCount: 0,
      stoppedForTask: false,
    }
  }
  return conv.compactionState
}

/**
 * Format turns as readable markdown for workspace archival.
 */
function formatTurnsAsMarkdown(turns: ChatMessage[][]): string {
  const lines: string[] = []
  for (const turn of turns) {
    for (const msg of turn) {
      if (msg.role === 'user') {
        lines.push(`**User:** ${msg.content}`)
      } else if (msg.role === 'assistant') {
        const text = msg.content || '(tool call)'
        lines.push(`**Assistant:** ${text}`)
      } else if (msg.role === 'tool') {
        const snippet = msg.content.length > 200 ? msg.content.slice(0, 200) + '…' : msg.content
        lines.push(`**Tool (${msg.name || 'unknown'}):** ${snippet}`)
      }
    }
    lines.push('') // blank line between turns
  }
  return lines.join('\n')
}

const SUMMARIZE_PROMPT =
  'Summarize the following conversation concisely. Focus on:\n' +
  '- Key decisions made\n' +
  '- Important information exchanged\n' +
  '- Actions taken\n' +
  '- Outcomes achieved\n' +
  'Be brief but capture all important details. Use bullet points.'

/**
 * Tier-based context compaction with workspace archival and LLM summarization.
 *
 * Dependencies are optional — when not provided, all tiers fall back to
 * simple truncation (original Phase 6 behavior).
 */
export class PressureContextManager implements ContextManager {
  private readonly maxTokens: number
  private readonly workspace?: Workspace
  private readonly llmPort?: LlmPort
  private readonly tokenCounter?: TokenCounter
  private readonly dryRun: boolean
  private readonly ineffectiveRatio: number
  private readonly ineffectiveMaxRun: number
  private readonly events?: AgentEventEmitter
  private readonly taskId?: string
  private readonly prePruneEnabled: boolean
  private readonly prePruneOptions?: PrePruneOptions
  private readonly structuredSummaryEnabled: boolean
  private readonly onCompactionEffective?: (info: {
    conversationId: string
    tier: CompactionTier
  }) => void
  /**
   * T1.1 — Previous structured summary text. Persists across compactions
   * within the same task so the next call sends `### Previous Summary` and
   * asks for a DELTA UPDATE instead of a full re-summary (avoids summary
   * drift). Reset on task termination; not persisted across pod restarts in
   * T1.1 (T2.1 SQLite store will persist it).
   */
  private _previousSummary: string | null = null

  /**
   * @param maxTokens     - Maximum context window size in tokens.
   * @param workspace     - WorkspaceService for archiving turns to daily log.
   * @param llmPort       - LlmPort for summarization (85-95% tier).
   * @param tokenCounter  - P.2 provider-aware counter. When provided, the
   *                        manager uses it (or the dry-run delta) instead of
   *                        the heuristic. When omitted, falls back to legacy.
   * @param options       - P.2 dry-run gating + T1.4 anti-thrash thresholds.
   */
  constructor(
    maxTokens: number = 100000,
    workspace?: Workspace,
    llmPort?: LlmPort,
    tokenCounter?: TokenCounter,
    options: PressureContextManagerOptions = {}
  ) {
    this.maxTokens = maxTokens
    this.workspace = workspace
    this.llmPort = llmPort
    this.tokenCounter = tokenCounter
    this.dryRun = options.dryRun ?? false
    this.ineffectiveRatio = options.ineffectiveRatio ?? 0.9
    this.ineffectiveMaxRun = options.ineffectiveMaxRun ?? 2
    this.events = options.events
    this.taskId = options.taskId
    this.prePruneEnabled = options.prePruneEnabled ?? false
    this.prePruneOptions = options.prePruneOptions
    this.structuredSummaryEnabled = options.structuredSummaryEnabled ?? false
    this.onCompactionEffective = options.onCompactionEffective
  }

  /**
   * T1.1 — accessor for tests that need to assert state across calls.
   */
  getPreviousSummary(): string | null {
    return this._previousSummary
  }

  /**
   * T1.1 — invoked by `TaskExecutor.handleLoopResult` (or the manual compact
   * endpoint) when the task wraps up. Mirrors how `CompactionState` already
   * gets reset on terminal results in T1.4.
   */
  resetPreviousSummary(): void {
    this._previousSummary = null
  }

  async manage(
    messages: ChatMessage[],
    conversation: Conversation,
    options?: ContextManageOptions
  ): Promise<ChatMessage[]> {
    // IronClaw invariant #1 (P.3 §4.1 + P.5 §5.3 hybrid guard):
    // primary defense is in `runToolUseLoop` via `LoopConfig.skipContextManager`
    // (emits `compaction:skipped` + owns the metric). This in-method check is
    // a SECOND LINE OF DEFENSE for callers that bypass the loop — e.g. the
    // `POST /v1/runtime/compact` endpoint (T1.1) or direct unit tests. Silent
    // passthrough on purpose: the loop is the metric owner. T1.4 also relies
    // on the early-return so `compactionState` is left untouched (the
    // defensive guard must not count against `ineffectiveCount`).
    if (conversation.pending_approval !== undefined) {
      return messages
    }

    // T1.1 — `forceTier: 'summarize'` bypasses the pressure-based dispatcher
    // entirely. Used by `POST /v1/runtime/compact` so an operator can request
    // a summary regardless of current token usage (focus topic, etc.). Pre-prune
    // and anti-thrash bookkeeping are skipped: a forced summarize is a
    // single-shot operator action, not part of the auto-compaction cadence.
    if (options?.forceTier === 'summarize') {
      const systemMsgs = messages.filter(m => m.role === 'system')
      const nonSystemMsgs = messages.filter(m => m.role !== 'system')
      const postMessages = await this.summarize(systemMsgs, nonSystemMsgs, 5, options?.focus)
      const ratio = measureCompactionRatio(messages, postMessages)
      clerumCompactionRatio.observe(ratio)
      clerumCompactionTotal.inc({ tier: 'summarize', outcome: 'ok' })
      this.onCompactionEffective?.({ conversationId: conversation.id, tier: 'summarize' })
      return postMessages
    }

    const pressure = await this.computePressure(messages)

    if (pressure < 0.8) {
      return messages // Passthrough — does NOT touch compactionState (no attempt made).
    }

    // T1.2 — deterministic pre-prune BEFORE any tier runs. Operates on a
    // copy; if linkages break (e.g. a bug in a new pass) `validateToolLinkages`
    // hard-fails per P1-011 — no try/catch, the goldens must catch it. When
    // pre-prune alone brings pressure back under 80%, we return the pruned
    // set without invoking the tier (no LLM call, no workspace write).
    let working = messages
    if (this.prePruneEnabled) {
      const result = prePrune(messages, this.prePruneOptions)
      working = result.messages
      if (result.passesApplied.length > 0) {
        validateToolLinkages(working)
        const savings = result.preTokens - result.postTokens
        if (savings > 0) {
          clerumPrePruneSavingsTokensTotal.inc(savings)
        }
        this.emitPrePruneEvent(conversation.id, result)
        const newPressure = await this.computePressure(working)
        if (newPressure < 0.8) {
          return working // pre-prune alone was enough — skip the tier.
        }
      }
    }

    // T1.4 — lagged backoff transition. The 2nd consecutive ineffective
    // compaction does run (matches plan §8.1 case 3: `ineffectiveCount === 2`,
    // `stoppedForTask === false`). On the NEXT invocation the top-of-method
    // check sees the count, flips `stoppedForTask`, emits the one-shot event
    // and returns no-op (plan §8.1 case 4: "el backoff dispara recién en la
    // siguiente llamada"). The `!stoppedForTask` guard makes the event fire
    // exactly once per task.
    const state = ensureCompactionState(conversation)
    if (state.ineffectiveCount >= this.ineffectiveMaxRun) {
      if (!state.stoppedForTask) {
        state.stoppedForTask = true
        this.emitThrashingEvent(conversation.id, state.lastRatio, state.ineffectiveCount)
      }
      clerumCompactionTotal.inc({ tier: tierLabel(pressure), outcome: 'thrashing' })
      return working
    }

    // Always keep system message(s)
    const systemMsgs = working.filter(m => m.role === 'system')
    const nonSystemMsgs = working.filter(m => m.role !== 'system')

    let postMessages: ChatMessage[]
    let tier: CompactionTier
    if (pressure >= 0.95) {
      tier = 'truncate'
      postMessages = this.truncate(systemMsgs, nonSystemMsgs, 3)
    } else if (pressure >= 0.85) {
      tier = 'summarize'
      // Auto-compaction never carries a focus; the field is only meaningful
      // for `forceTier: 'summarize'`. Explicitly pass `undefined` so that a
      // caller who hands `{ focus }` without `forceTier` cannot accidentally
      // bias the automatic summary (the `forceTier === 'summarize'` branch
      // above is the only legitimate consumer of `options?.focus`).
      postMessages = await this.summarize(systemMsgs, nonSystemMsgs, 5, undefined)
    } else {
      tier = 'move_to_workspace'
      postMessages = await this.moveToWorkspace(systemMsgs, nonSystemMsgs, 8)
    }

    // T1.4 — measure effectiveness on the heuristic so trigger and measurement
    // share rounding. Histogram is observed for every *real* attempt.
    // Denominator is `working` (post pre-prune), not `messages`: pre-prune
    // already emitted its own savings event/metric, and using the original
    // input would let pre-prune deflate the ratio and mask an ineffective
    // tier — defeating the anti-thrash backoff.
    const ratio = measureCompactionRatio(working, postMessages)
    clerumCompactionRatio.observe(ratio)
    state.lastRatio = ratio

    if (ratio > this.ineffectiveRatio) {
      state.ineffectiveCount += 1
    } else {
      state.ineffectiveCount = 0
    }
    clerumCompactionTotal.inc({ tier, outcome: 'ok' })

    // T2.2 — fire the compaction-effective hook so prompt-cache callers can
    // invalidate the cached `parts` (the `stable` tier re-snapshots the daily
    // log on the next build). Only on `summarize` because that's the tier the
    // plan describes as "new session of the lineage" (§5.3a / §5.7); the
    // truncate / move_to_workspace tiers drop turns without changing the
    // session identity, so the cache stays valid.
    //
    // TODO(T2.2 round 2): `move_to_workspace` appends archived turns to the
    // daily log, which IS included in the semi-stable system-prompt tier.
    // `parts[1]` stays stale until the next task start re-snapshots the
    // daily log. The mismatch is bounded (move_to_workspace only fires in
    // pressure ∈ [0.8, 0.85) and the daily log refreshes at task start),
    // but it is not zero. Before expanding invalidations to this tier:
    // instrument prompt-cache hit-rate before/after, then decide whether
    // the extra invalidation pays for itself.
    if (tier === 'summarize') {
      this.onCompactionEffective?.({ conversationId: conversation.id, tier })
    }

    return postMessages
  }

  /**
   * T1.2 — emit `compaction:pre_prune_executed` whenever any pass mutated the
   * message array. Silent no-op when no emitter was wired (e.g. unit tests).
   */
  private emitPrePruneEvent(
    conversationId: string,
    result: { preTokens: number; postTokens: number; passesApplied: string[] }
  ): void {
    if (!this.events) return
    this.events.emit({
      type: 'compaction:pre_prune_executed',
      data: {
        taskId: this.taskId,
        conversationId,
        preTokens: result.preTokens,
        postTokens: result.postTokens,
        savingsTokens: result.preTokens - result.postTokens,
        savingsRatio: result.preTokens > 0 ? result.postTokens / result.preTokens : 1,
        passesApplied: result.passesApplied,
      },
      timestamp: new Date(),
    })
  }

  /**
   * T1.4 — emit the one-shot `compaction:thrashing` event on the core bus.
   * `eventWiring.ts` translates it into a `compaction.skipped`-style activity
   * record (warning severity). Silent no-op when no emitter was wired.
   */
  private emitThrashingEvent(
    conversationId: string,
    lastRatio: number,
    consecutiveCount: number
  ): void {
    if (!this.events) return
    this.events.emit({
      type: 'compaction:thrashing',
      data: {
        taskId: this.taskId,
        conversationId,
        lastRatio,
        consecutiveCount,
      },
      timestamp: new Date(),
    })
  }

  /**
   * Resolve the pressure ratio according to the dry-run gate. Three branches:
   *   - No counter: legacy heuristic (preserves pre-P.2 behavior bit-for-bit).
   *   - dryRun=true: compute BOTH numbers; the heuristic decides the tier; the
   *     delta and any tier mismatch are emitted as metrics for the bake-week.
   *   - dryRun=false: the counter (with `lastObservedInputTokens` shortcut)
   *     drives the decision directly.
   */
  private async computePressure(messages: ChatMessage[]): Promise<number> {
    if (!this.tokenCounter) {
      return estimateTokens(messages) / this.maxTokens
    }
    if (this.dryRun) {
      const heuristic = estimateTokens(messages)
      let real: number
      try {
        real = await this.measureWithCounter(messages)
      } catch (err) {
        console.warn('[ContextManager] dryrun counter failed; using heuristic:', err)
        return heuristic / this.maxTokens
      }
      const heuristicTier = tierFor(heuristic / this.maxTokens)
      const realTier = tierFor(real / this.maxTokens)
      const delta = heuristic > 0 ? real / heuristic : 0
      tokenizerDryrunDelta.observe(
        { provider: this.tokenCounter.providerName, tier_chosen: heuristicTier },
        delta
      )
      if (heuristicTier !== realTier) {
        tokenizerDryrunTierMismatchTotal.inc({ from: heuristicTier, to: realTier })
      }
      return heuristic / this.maxTokens
    }
    return (await this.measureWithCounter(messages)) / this.maxTokens
  }

  private async measureWithCounter(messages: ChatMessage[]): Promise<number> {
    // The `lastObservedInputTokens` shortcut (Hermes `update_from_response`)
    // is intentionally NOT applied here in the first PR: the call site runs
    // once per loop iteration so the per-decision call is affordable, and
    // skipping `count()` would risk under-counting messages added since the
    // last response. T2.2 (prompt cache) revisits this with a per-iteration
    // shape diff.
    return this.tokenCounter!.count(messages)
  }

  /**
   * Compute the aligned cut + kept/archived split for a given keepRecent count.
   * Shared by all three tiers — every tier first picks the proposed cut by
   * turn count, then passes it through the T1.3 boundary aligner so the cut
   * never splits a tool-call pair and never archives the last user message.
   */
  private alignedSlice(
    systemMsgs: ChatMessage[],
    nonSystemMsgs: ChatMessage[],
    keepRecent: number
  ): { kept: ChatMessage[]; archived: ChatMessage[] } {
    const turns = splitTurns(nonSystemMsgs)
    const proposedCut = turnIndexToMessageIndex(turns, Math.max(0, turns.length - keepRecent))
    return applyAlignedCut(systemMsgs, nonSystemMsgs, proposedCut)
  }

  /**
   * Truncate: drop old turns, no archival. Used for emergency (>95%).
   */
  private truncate(
    systemMsgs: ChatMessage[],
    nonSystemMsgs: ChatMessage[],
    keepRecent: number
  ): ChatMessage[] {
    const { kept } = this.alignedSlice(systemMsgs, nonSystemMsgs, keepRecent)
    return kept
  }

  /**
   * MoveToWorkspace: format old turns as markdown, append to daily log,
   * then drop them. Falls back to truncate if no workspace available.
   */
  private async moveToWorkspace(
    systemMsgs: ChatMessage[],
    nonSystemMsgs: ChatMessage[],
    keepRecent: number
  ): Promise<ChatMessage[]> {
    const { kept, archived } = this.alignedSlice(systemMsgs, nonSystemMsgs, keepRecent)

    if (this.workspace && archived.length > 0) {
      const archivedTurns = splitTurns(archived)
      const markdown = formatTurnsAsMarkdown(archivedTurns)
      const header = `### Context Compacted (${archivedTurns.length} turns archived)\n\n`
      try {
        await this.workspace.appendDailyLog(header + markdown)
        console.log(
          `[ContextManager] MoveToWorkspace: archived ${archivedTurns.length} turns to daily log`
        )
      } catch (err) {
        console.error('[ContextManager] MoveToWorkspace: failed to archive turns:', err)
      }
    }

    return kept
  }

  /**
   * Summarize: call LLM to summarize old turns, write summary to daily log,
   * then drop old turns. Falls back to truncate if no LLM port available.
   *
   * T1.1 — when `structuredSummaryEnabled` is true the prompt switches to the
   * section-anchored template (`structuredSummaryTemplate.ts`) and the output
   * is run through `parseStructuredSummary`. If the LLM ignores the schema
   * the rawBody is persisted anyway and `_previousSummary` is updated for the
   * next delta attempt. `focus` is honoured only in the structured path; in
   * the legacy path it is silently ignored (auto-compaction never sets it).
   */
  private async summarize(
    systemMsgs: ChatMessage[],
    nonSystemMsgs: ChatMessage[],
    keepRecent: number,
    focus?: string
  ): Promise<ChatMessage[]> {
    const { kept, archived } = this.alignedSlice(systemMsgs, nonSystemMsgs, keepRecent)

    if (archived.length === 0) {
      return kept
    }

    // If no LLM port, fall back to MoveToWorkspace behavior
    if (!this.llmPort) {
      return this.moveToWorkspace(systemMsgs, nonSystemMsgs, keepRecent)
    }

    const archivedTurns = splitTurns(archived)
    const conversationText = formatTurnsAsMarkdown(archivedTurns)
    const useStructured = this.structuredSummaryEnabled
    const systemPrompt = useStructured
      ? buildStructuredSummaryPrompt({
          previousSummary: this._previousSummary,
          focus: focus ?? null,
          maxTokens: 1024,
        })
      : SUMMARIZE_PROMPT

    const summarizationMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: conversationText },
    ]

    let rawSummary: string
    try {
      const response = await this.llmPort.complete({
        messages: summarizationMessages,
        max_tokens: 1024,
        temperature: 0.3,
      })
      rawSummary = response.content
      console.log(
        `[ContextManager] Summarize: condensed ${archivedTurns.length} turns into ${rawSummary.length} chars`
      )
    } catch (err) {
      console.error(
        '[ContextManager] Summarize: LLM call failed, falling back to MoveToWorkspace:',
        err
      )
      return this.moveToWorkspace(systemMsgs, nonSystemMsgs, keepRecent)
    }

    let summaryToPersist = rawSummary
    if (useStructured) {
      const parsed = parseStructuredSummary(rawSummary)
      clerumCompactionStructuredParseTotal.inc({ outcome: parsed.parseStatus })

      if (parsed.parseStatus === 'fallback') {
        console.warn('[ContextManager] Summarize: LLM ignored structured schema, using raw output')
      }
      // Plan §6.2 — if the Memory Writes header is present but contents were
      // rejected (paraphrased / unanchored), append a placeholder so the agent
      // re-reads MEMORY.md from disk on resume.
      const memoryHeaderSeen = /^##\s+Memory Writes/im.test(rawSummary)
      if (memoryHeaderSeen && parsed.memoryWrites === null) {
        summaryToPersist =
          rawSummary + '\n\n[memory writes section could not be parsed — review previous turn]\n'
      }
      // Always stash the rawBody for the next delta-patch — even on fallback,
      // the next iteration can at least diff against it.
      this._previousSummary = parsed.rawBody
    }

    // Write summary to workspace
    if (this.workspace) {
      const header = `### Context Summary (${archivedTurns.length} turns summarized)\n\n`
      try {
        await this.workspace.appendDailyLog(header + summaryToPersist)
      } catch (err) {
        console.error('[ContextManager] Summarize: failed to write summary:', err)
      }
    }

    return kept
  }
}

/**
 * Simple single-threshold context manager for in-loop usage.
 * Passes through if under threshold, otherwise keeps last N turns.
 */
export class InLoopContextManager implements ContextManager {
  private readonly thresholdTokens: number
  private readonly maxTurns: number

  constructor(thresholdTokens: number = 80000, maxTurns: number = 5) {
    this.thresholdTokens = thresholdTokens
    this.maxTurns = maxTurns
  }

  manage(
    messages: ChatMessage[],
    conversation: Conversation,
    _options?: ContextManageOptions
  ): ChatMessage[] {
    // IronClaw invariant #1 — same defensive guard as PressureContextManager.
    if (conversation.pending_approval !== undefined) {
      return messages
    }
    const estimated = estimateTokens(messages)

    if (estimated < this.thresholdTokens) {
      return messages // Passthrough
    }

    const systemMsgs = messages.filter(m => m.role === 'system')
    const nonSystemMsgs = messages.filter(m => m.role !== 'system')

    const turns = splitTurns(nonSystemMsgs)
    const proposedCut = turnIndexToMessageIndex(turns, Math.max(0, turns.length - this.maxTurns))
    const { kept } = applyAlignedCut(systemMsgs, nonSystemMsgs, proposedCut)
    return kept
  }
}
