/**
 * `projectForHook` — the content projection for installed `/v1` hooks (spec §8.4).
 *
 * An installed hook is untrusted third-party code, so it NEVER receives the raw
 * `ToolCompletionRequest`/response. This builds the per-point request body from a
 * projection with exactly two jobs:
 *
 *   - SCOPE, don't scrub. It selects which FIELDS a hook receives; it never masks
 *     values inside a field it does send — a PII/moderation hook still sees the raw
 *     content it exists to inspect (redaction stays a hook's `post_call` OUTPUT
 *     transform, never an input filter).
 *   - Deny the first-party system prompt in EVERY projection: system-role messages
 *     are stripped and `systemPromptParts` is never forwarded, regardless of
 *     `contentAccess` (§8.1 — the system prompt is immutable to, and invisible to,
 *     installed hooks). Internal-only fields (`signal`, `usageContext`) are dropped
 *     too — they are not part of the wire contract and must not reach a hook.
 *
 * Content need is per point: `moderate`/`post_call`/`on_error` are inherently
 * content-bearing; `pre_call` receives messages only when the hook is NOT a
 * `metadata`-only shaper (§8.7). A `metadata` `pre_call` hook gets model + params +
 * tool schemas but no message bodies, which is what lets it egress at low trust.
 */
import { redactDiagnosticField } from '../../redactDiagnostics.js'
import type { ChatMessage, ToolCompletionRequest, ToolCompletionResponse } from '../../types'
import type { HookDescriptor, LifecyclePoint } from './types'

/** Fields never forwarded to a hook: the system prompt (both forms) + internal-only wiring. */
const REQUEST_FIELDS_NEVER_SENT = [
  'systemPromptParts',
  'signal',
  'usageContext',
  'messages',
] as const

function stripSystemRole(messages: ChatMessage[] | undefined): ChatMessage[] {
  return (messages ?? []).filter(m => m.role !== 'system')
}

/**
 * Project a request: always drop the system prompt + internal fields; include the
 * non-system messages only when `includeMessages` (the content flavor). Keeps
 * params + tool schemas (`tools`, `temperature`, `max_tokens`, `tool_choice`).
 */
function projectRequest(
  request: ToolCompletionRequest,
  includeMessages: boolean
): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...(request as unknown as Record<string, unknown>) }
  for (const f of REQUEST_FIELDS_NEVER_SENT) delete projected[f]
  if (includeMessages) projected.messages = stripSystemRole(request.messages)
  return projected
}

/** A `pre_call` hook receives messages unless it explicitly declared `metadata`-only (§8.7). */
export function preCallIncludesContent(descriptor: HookDescriptor): boolean {
  return descriptor.contentAccess !== 'metadata'
}

/**
 * Project an error for an `on_error` hook to ONLY the §8.1 wire fields
 * {code, message, retryable}. The raw error is never forwarded: an LlmError's
 * enumerable own props (`provider`, and a `cause` chain to the provider SDK
 * error carrying status / response headers / request metadata) would leak, and
 * `Error.prototype.message` is non-enumerable so a straight pass-through drops
 * the very message the hook exists to recover from. `message` is read by
 * property access (so it's included) and run through the shared diagnostic
 * redaction (+120-char cap); `code` is a fixed enum; everything else is dropped.
 */
function projectError(error: unknown): {
  code?: string
  message?: string
  retryable?: boolean
} {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; retryable?: unknown }
  const out: { code?: string; message?: string; retryable?: boolean } = {}
  if (typeof e.code === 'string') out.code = e.code
  if (typeof e.message === 'string') out.message = redactDiagnosticField(e.message).slice(0, 120)
  if (typeof e.retryable === 'boolean') out.retryable = e.retryable
  return out
}

/** Build the `/v1/{point}` request body for a hook, per the §8.4 projection contract. */
export function projectForHook(
  descriptor: HookDescriptor,
  point: LifecyclePoint,
  ctx: {
    request?: ToolCompletionRequest
    response?: ToolCompletionResponse
    error?: unknown
  }
): unknown {
  switch (point) {
    case 'pre_call':
      return projectRequest(
        ctx.request as ToolCompletionRequest,
        preCallIncludesContent(descriptor)
      )
    case 'moderate':
      return projectRequest(ctx.request as ToolCompletionRequest, true)
    case 'post_call': {
      const r = ctx.response as ToolCompletionResponse
      return {
        response: { content: r.content, tool_calls: r.tool_calls, finish_reason: r.finish_reason },
        usage: r.usage,
      }
    }
    case 'on_error':
      return {
        request: projectRequest(ctx.request as ToolCompletionRequest, true),
        error: projectError(ctx.error),
      }
    default:
      return {}
  }
}
