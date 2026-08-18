import type { GuardrailInputChangeLite } from '../hooks/useChatStore'
import { formatSignedTokenDelta } from './format'

/** First-party display names for built-ins (spec §7.4/D5). */
const BUILTIN_DISPLAY_NAMES: Record<string, string> = {
  'token-trim': 'token-trim (built-in)',
  'prompt-shaping': 'prompt-shaping (built-in)',
}

/**
 * Display label for one guardrail source (spec §7.4). Built-ins get a first-party
 * display name; an installed hook shows its `LlmHook` CR name verbatim —
 * admin-authored config, already length-capped at projection and escaped by React
 * on render. Hook-supplied `code`/`message` strings are NEVER rendered (§8).
 */
export function guardrailSourceLabel(change: GuardrailInputChangeLite): string {
  if (change.kind === 'builtin') {
    return BUILTIN_DISPLAY_NAMES[change.sourceId] ?? `${change.sourceId} (built-in)`
  }
  return change.sourceId
}

/** Per-source value: a signed delta, or `changed` for a same-size rewrite (D4). */
export function guardrailRowValue(change: GuardrailInputChangeLite): string {
  if (change.deltaTokens === 0) return change.changed ? 'changed' : '0'
  return formatSignedTokenDelta(change.deltaTokens)
}
