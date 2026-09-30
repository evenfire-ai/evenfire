import {
  type ChatMessage,
  type MessageContentImageSource,
  type MessageContentPart,
  textContentFromParts,
} from '../core/types'
import { CodexAuthorizeError } from './providerAttemptAuthorizer'

/**
 * A pre-authorize refusal. Both providers' `classifyError` have an explicit
 * arm that maps it to a non-retryable `ApiCallFailed`.
 */
export const IMAGE_SOURCE_INVALID = 'image_source_invalid'

function imageSourceError(detail: string): CodexAuthorizeError {
  return new CodexAuthorizeError(
    IMAGE_SOURCE_INVALID,
    `image part has no usable provenance source (${detail}); host producers must attach the attachment or tool call it came from`
  )
}

/**
 * Provenance for one image part, shared by the Codex and Grok providers. Both
 * contracts require a source on every V2 image and bound its id charset; this
 * checks only presence and shape, so each contract stays the single owner of
 * format and size limits.
 */
export function projectImageSource(
  part: Extract<MessageContentPart, { type: 'image' }>
): MessageContentImageSource {
  const source = part.source
  if (!source) throw imageSourceError('missing source')
  if (source.kind === 'attachment') {
    if (!source.attachmentId?.trim()) throw imageSourceError('empty attachmentId')
    if (!source.messageId?.trim()) throw imageSourceError('empty messageId')
    return {
      kind: 'attachment',
      attachmentId: source.attachmentId,
      messageId: source.messageId,
    }
  }
  if (source.kind === 'tool') {
    if (!source.attachmentId?.trim()) throw imageSourceError('empty attachmentId')
    if (!source.toolCallId?.trim()) throw imageSourceError('empty toolCallId')
    return { kind: 'tool', attachmentId: source.attachmentId, toolCallId: source.toolCallId }
  }
  // A GFS read (#670) is a tool result: both contracts name it by its read's
  // attachment and tool call.
  if (source.kind === 'gfs') {
    if (!source.attachmentId?.trim()) throw imageSourceError('empty attachmentId')
    if (!source.toolCallId?.trim()) throw imageSourceError('empty toolCallId')
    return { kind: 'tool', attachmentId: source.attachmentId, toolCallId: source.toolCallId }
  }
  throw imageSourceError('unknown source kind')
}

/** One image part as the Codex and Grok V2 contracts serialize it. */
export type ProjectedImagePart = {
  type: 'image'
  mimeType: 'image/jpeg' | 'image/png'
  data: string
  source: MessageContentImageSource
}

/** One message as either contract version serializes it. */
export type ProjectedMessage = {
  role: ChatMessage['role']
  content: string
  contentParts?: Array<{ type: 'text'; text: string } | ProjectedImagePart>
  name?: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

/**
 * Project one loop message onto the wire contract, for both providers. The
 * caller passes the provider's `invalid_request` code for the one refusal made
 * here (content parts on a non-user message).
 *
 * A turn with no parts stays byte-identical to V1. As soon as one message
 * carries parts the whole request moves to V2, where the text parts are
 * authoritative for `content` - that is what keeps a redacted (text-only)
 * message consistent with the contract's equality rule (#784).
 */
export function projectMessage(message: ChatMessage, invalidRequestCode: string): ProjectedMessage {
  const projected: ProjectedMessage = {
    role: message.role,
    content: message.content ?? '',
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    ...(message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0
      ? {
          toolCalls: message.tool_calls.map(call => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        }
      : {}),
  }
  const parts = message.contentParts
  if (!parts || parts.length === 0) return projected
  if (message.role !== 'user') {
    throw new CodexAuthorizeError(
      invalidRequestCode,
      `content parts are only supported on user messages (role=${message.role})`
    )
  }
  const contentParts: NonNullable<ProjectedMessage['contentParts']> = parts.map(part =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image',
          mimeType: part.mimeType,
          data: part.data,
          source: projectImageSource(part),
        }
  )
  return { ...projected, content: textContentFromParts(contentParts), contentParts }
}

/**
 * The contract `limit` refusals that mean "this turn carries too much", shared
 * by the Codex and Grok providers. Both contracts word these refusals
 * identically, so one list serves both; each contract's own tests pin its
 * refusals (T-C, T-C2, T-C3 and T-C5, with a `-grok` suffix for Grok).
 *
 * Of the `fail('limit', ...)` checks on a request, only these are about
 * conversation volume, in `llm-provider-attempt-contract/index.cjs` and
 * `grok-provider-attempt-contract/index.cjs`: the real byte bound and its
 * non-image share on a V2 request (both in `parse{Codex,Grok}CompletionRequestRoot`),
 * the independent element bound (`checkStructure`), and `maxMessages` and
 * `messages[i].toolCalls` (both in `parseMessages`).
 * All five are request-volume refusals mapped to `ContextLengthExceeded` -
 * "Conversation Too Long" in the UI. Compaction reaches them unevenly. The
 * context manager counts bytes and, through the registry's `maxMessages`,
 * the message count; it does not count JSON values. A single turn holding
 * more than `maxMessages` messages stays unshrinkable, because the cut never
 * lands inside a turn. A large tool definition is also not compactable.
 * `maxToolCalls` also bounds every response, so only history produced by
 * another provider can carry an over-long `toolCalls` array.
 *
 * The others are not. Nesting depth (`checkStructure`, `assertFiniteTree`),
 * `generation.maxOutputTokens` (`parseGeneration`) and `deadlineMs`
 * (`parse{Codex,Grok}CompletionRequestRoot`) out of range are malformed or
 * out-of-range parameters, and a shorter conversation fixes none of them;
 * labelling them a context-length failure would send the user into a
 * compaction loop that cannot converge. They stay `invalid_request`, which is
 * what "fails an over-deep tool schema locally without a stack overflow" in
 * `subscriptionRequestHash.test.ts` pins for the over-deep schema across both
 * providers. The image budgets belong to the attachments, not the
 * conversation: a `size` one is `attachment_too_large` (see
 * `ATTACHMENT_BUDGET_REFUSALS` in each provider), the `maxImages` `count` one
 * stays `invalid_request`. The structural volume bounds
 * (`maxRequestContainers` and `maxRequestMembers`, both from `checkStructure`)
 * are volume too, but they are not listed: each carries `kind: 'size'`, so it
 * reaches the user as `payload_too_large`, which classifies the same way
 * (T-C3b for containers, T-C3d for members; the proxy's raw-body member 413 is
 * T-C3c; `-grok` suffix for Grok).
 *
 * `hashCanonical{Codex,Grok}Request` also returns a `kind` (#784), but it
 * cannot replace the message here: `size` covers the conversation bytes and the
 * image byte budgets alike (the Codex contract adds dimension budgets), and a
 * shorter conversation fixes the first and not the second. `count` covers
 * `maxImages` in both contracts, and `maxMessages` and `maxToolCalls` in the
 * Codex one. So the
 * message stays the discriminator at this boundary (#731). The byte pattern is
 * a prefix so it covers the `outside image data` check of a V2 request. The
 * element bound has its own explicit pattern.
 *
 * `messages exceed` is defence in depth rather than a reachable branch: the
 * guard in each provider's `execute` raises that exact message with this same
 * classification before `hashCanonical{Codex,Grok}Request` runs, so the
 * contract's own copy of it only arrives here if that guard is ever removed.
 */
const CONTEXT_LENGTH_REFUSALS = [
  /^request exceeds maxRequestBodyBytes/,
  /^request exceeds maxRequestElements$/,
  /^messages exceed \d+$/,
  /^messages\[\d+\]\.toolCalls exceed \d+$/,
]

export function isContextLengthRefusal(code: string, message: string): boolean {
  return code === 'limit' && CONTEXT_LENGTH_REFUSALS.some(pattern => pattern.test(message))
}

/**
 * The code for a contract refusal that is not an attachment refusal, shared by
 * both providers' pre-dispatch checks and the Grok proxy envelope: a
 * conversation-volume limit is a context-length failure, any other `size`
 * refusal is `payload_too_large`, and everything else (`count` included) is an
 * invalid request.
 */
export function canonicalRefusalCode(refusal: {
  code: string
  message: string
  kind?: string
}): string {
  if (isContextLengthRefusal(refusal.code, refusal.message)) return 'request_limit_exceeded'
  if (refusal.kind === 'size') return 'payload_too_large'
  return 'invalid_request'
}
