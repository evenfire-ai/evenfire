/**
 * Provider-fallback (R5) — parse `spec.llmPolicy` off the Host CR.
 *
 * mcp-host reads the Host CR directly (`getHost` / `HostWatcher`), so the raw
 * `spec.llmPolicy` object arrives untyped from the K8s API (the CRD schema is
 * added by the separate CRD block — mcp-host only CONSUMES the field). This
 * parser is defensive and tolerant: an absent / malformed / empty policy →
 * `null` = no failover = byte-identical to today's behaviour (spec §3-R5.1).
 */
import { ALL_FAILOVER_CLASSES } from './classify'
import type { FailoverClass, FallbackEntry, LlmPolicy } from './types'

const DEFAULT_COOLDOWN_SECONDS = 300

function isFailoverClass(value: unknown): value is FailoverClass {
  return typeof value === 'string' && ALL_FAILOVER_CLASSES.includes(value as FailoverClass)
}

/** The `cooldownSeconds` + `triggerOn` block shared by every llmPolicy shape. */
export interface CooldownAndTriggers {
  cooldownSeconds: number
  triggerOn: FailoverClass[]
}

/**
 * Parse the `cooldownSeconds` + `triggerOn` fields common to both llmPolicy
 * shapes (the Host CR here + the workflow `configure` request in
 * `workflow/failoverProvider.ts`), so FIX-1's `>= 0` guard lives in ONE place.
 *
 * `cooldownSeconds` accepts any NON-NEGATIVE integer — `0` is a legitimate value
 * the CRD (`minimum: 0`) and UI allow (the primary expires from cooldown
 * immediately, i.e. it is retried on the very next call). An absent / non-integer
 * / negative value → default 300. `triggerOn` honours an explicit (possibly
 * empty) subset and drops unrecognised classes; absent → all four classes.
 */
export function parseCooldownAndTriggers(rec: Record<string, unknown>): CooldownAndTriggers {
  let cooldownSeconds = DEFAULT_COOLDOWN_SECONDS
  if (Number.isInteger(rec.cooldownSeconds) && (rec.cooldownSeconds as number) >= 0) {
    cooldownSeconds = rec.cooldownSeconds as number
  }

  let triggerOn: FailoverClass[] = [...ALL_FAILOVER_CLASSES]
  if (Array.isArray(rec.triggerOn)) {
    // Honour an explicit (possibly empty) subset; drop unrecognised classes.
    triggerOn = rec.triggerOn.filter(isFailoverClass)
  }

  return { cooldownSeconds, triggerOn }
}

function parseFallbackEntry(raw: unknown): FallbackEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.provider !== 'string' || rec.provider.length === 0) return null
  if (typeof rec.model !== 'string' || rec.model.length === 0) return null
  const entry: FallbackEntry = { provider: rec.provider, model: rec.model }
  if (typeof rec.credentialSlot === 'string' && rec.credentialSlot.length > 0) {
    entry.credentialSlot = rec.credentialSlot
  }
  return entry
}

/**
 * Normalize the raw `spec.llmPolicy` into an {@link LlmPolicy}, or `null` when
 * no usable failover is configured. Defaults: `cooldownSeconds` 300,
 * `triggerOn` all four classes. An explicit `triggerOn` is honoured (including
 * an explicitly empty list — the operator disabling all triggers). A policy
 * with no valid `fallbacks` collapses to `null`.
 */
export function parseLlmPolicy(raw: unknown): LlmPolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>

  if (!Array.isArray(rec.fallbacks)) return null
  const fallbacks: FallbackEntry[] = []
  for (const item of rec.fallbacks) {
    const entry = parseFallbackEntry(item)
    if (entry) fallbacks.push(entry)
  }
  if (fallbacks.length === 0) return null

  const { cooldownSeconds, triggerOn } = parseCooldownAndTriggers(rec)
  return {
    cooldownSeconds,
    triggerOn,
    fallbacks,
    ...(rec.budgetDeniedFailover === true ? { budgetDeniedFailover: true } : {}),
  }
}
