/**
 * Issue #654 — host-side image-input enforcement.
 *
 * The shared package (`@clerum/llm-providers`) owns the model-evidence contract
 * (`ImageInputCapability`) and the pure intersection
 * (`resolveImageInputCapability`). This module owns the HOST half:
 *
 *   1. which transport implementation + message role can carry an image for a
 *      given provider, and
 *   2. the injected resolver contract that lets the live catalog answer
 *      "what does the catalog say for (provider, model)?".
 *
 * Transport baseline (observed LOCAL serialization, not a model-capability
 * proof and not an account authorization):
 *
 *   family              complete  completeWithTools  …AndCache  image roles
 *   openai-compatible   no        yes                n/a        user
 *   claude              no        yes                yes        user, tool
 *   vertex              yes       yes                n/a        user
 *   bedrock             yes       yes                n/a        user
 *   codex-subscription  yes       yes                n/a        user
 *
 * `complete` is the tool-less, cache-less path (`completeSingleTurn`): OpenAI,
 * OpenAI-compatible and Azure rebuild `role/content` and drop `contentParts`,
 * so an image there is lost rather than rejected. `#653` owns fixing that path;
 * until then this module reports it as not image-capable so the guard fails
 * closed instead of silently dropping the image.
 */
import { type ImageInputDecision, resolveImageInputCapability } from '@clerum/llm-providers'
import type { ChatMessage, MessageRole } from '../core/types'
import { descriptorFor, isLlmProvider } from './registryCore'

/**
 * The only image media types the Host accepts on the wire. Both the admission
 * boundary and the adapter guard read this list, so a new type is enabled in
 * one place instead of two inline literals drifting apart.
 */
export const IMAGE_ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png'] as const

export type ImageAttachmentMimeType = (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number]

export function isImageAttachmentMime(value: unknown): value is ImageAttachmentMimeType {
  return (
    typeof value === 'string' && (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(value)
  )
}

/**
 * Canonical-base64 shape check that stays linear in V8.
 *
 * The grouped-quantifier form `(?:[A-Za-z0-9+/]{4})*` allocates one backtrack
 * frame per group and throws `RangeError: Maximum call stack size exceeded`
 * above ~4.47M characters — roughly a 3.2 MiB image, well inside the sizes this
 * Host accepts. `gfs-controller/src/api/serve.ts` already carries the same fix.
 * Length-mod-4 plus an unanchored character class decides the same shapes
 * without backtracking; the decode round-trip at the admission boundary remains
 * the authority on non-canonical padding bits.
 */
export function isCanonicalBase64Shape(data: string): boolean {
  return data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)
}

/**
 * The transport operation a request is about to use, named after the adapter
 * dispatch path (`complete`, `completeWithTools` and their `…AndCache`
 * variants), which maps 1:1 onto the `SingleTurnProvider` `completeSingleTurn*`
 * methods.
 */
export type ImageTransportOperation =
  | 'complete'
  | 'completeWithTools'
  | 'completeAndCache'
  | 'completeWithToolsAndCache'

/** Wire family — the unit that actually owns image serialization behavior. */
export type ImageWireFamily =
  | 'openai-compatible'
  | 'claude'
  | 'vertex'
  | 'bedrock'
  | 'codex'
  /**
   * No covered serializer exists for this id (unknown string, or a registered
   * provider with no factory arm we have proven). Every capability answer is
   * `false`, so a future divergent driver can never inherit OpenAI-compatible
   * coverage by accident.
   */
  | 'unregistered'

/**
 * Providers the factory (`registry.ts:makeProvider`) builds through an EXPLICIT
 * arm. These are the only ids whose serializer is pinned by provider id; every
 * other registered id must carry a real `baseURL` to reach the data-driven
 * OpenAI-compatible arm, and anything else gets no coverage at all.
 */
const EXPLICIT_DRIVER_FAMILY: Readonly<Record<string, ImageWireFamily>> = {
  openai: 'openai-compatible',
  claude: 'claude',
  vertex: 'vertex',
  bedrock: 'bedrock',
  azure: 'openai-compatible',
  'codex-subscription': 'codex',
}

export function imageWireFamilyFor(providerType: string): ImageWireFamily {
  const explicit = EXPLICIT_DRIVER_FAMILY[providerType]
  if (explicit) return explicit
  if (!isLlmProvider(providerType)) return 'unregistered'
  // Data-driven arm: a registered provider is built as an OpenAI-compatible
  // client only when its descriptor really carries a baseURL. Anything else
  // makes `makeProvider` throw, so it is not authorized here either.
  return descriptorFor(providerType).baseURL ? 'openai-compatible' : 'unregistered'
}

const TRANSPORT_SUPPORT: Readonly<
  Record<ImageWireFamily, Readonly<Record<ImageTransportOperation, boolean>>>
> = {
  'openai-compatible': {
    complete: false,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  claude: {
    complete: false,
    completeWithTools: true,
    completeAndCache: true,
    completeWithToolsAndCache: true,
  },
  vertex: {
    complete: true,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  bedrock: {
    complete: true,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  // #650: Codex V2 carries ordered image parts on the tool-less and
  // tool-bearing paths. Cache variants are not implemented on this transport.
  codex: {
    complete: true,
    completeWithTools: true,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
  unregistered: {
    complete: false,
    completeWithTools: false,
    completeAndCache: false,
    completeWithToolsAndCache: false,
  },
}

const IMAGE_ROLES_BY_FAMILY: Readonly<Record<ImageWireFamily, readonly MessageRole[]>> = {
  'openai-compatible': ['user'],
  claude: ['user', 'tool'],
  vertex: ['user'],
  bedrock: ['user'],
  codex: ['user'],
  unregistered: [],
}

/**
 * True when `operation` on `providerType` preserves the image part on the wire
 * for `role` (default `user`, the ordinary composer case).
 *
 * The answer is a property of the implementing serializer, never of the model
 * name or of OpenAI compatibility, so `/models` can project it directly.
 */
export function transportSupportsImageInput(
  providerType: string,
  operation: ImageTransportOperation,
  role: MessageRole = 'user'
): boolean {
  const family = imageWireFamilyFor(providerType)
  return TRANSPORT_SUPPORT[family][operation] && IMAGE_ROLES_BY_FAMILY[family].includes(role)
}

/**
 * Projection for the host `/models` wire: can the CHAT operation carry images?
 *
 * The reasoning port dispatches `completeWithTools` (`core/reasoning/port.ts`)
 * — with an empty tool array when no tools are registered — and the adapter
 * selects the cache-aware variant when the provider implements it. The context
 * manager's summarisation dispatches `complete`
 * (`core/extensions/contextManager.ts`), which the adapter checks per attempt
 * with the real method. This helper answers the admission-time question for the
 * chat turn only, so it takes the union of the two tool-bearing methods.
 */
export function chatTransportSupportsImageInput(providerType: string): boolean {
  return (
    transportSupportsImageInput(providerType, 'completeWithTools') ||
    transportSupportsImageInput(providerType, 'completeWithToolsAndCache')
  )
}

/**
 * Transport-independent facts for one (provider, model) pair, supplied by the
 * host's live-catalog resolver.
 */
export interface ImageInputCapabilitySource {
  /**
   * Raw or normalized capability from the catalog. Anything missing or
   * malformed normalizes to `unknown` inside the shared resolver, never to
   * affirmative support.
   */
  capability?: unknown
}

/**
 * Host → catalog lookup for image-input capability. Returns `undefined` when
 * the pair is not in the live catalog (treated as `unknown`, never as allow).
 * Implementations must be cheap and must not perform network I/O per call.
 */
export type ImageInputResolver = (
  provider: string,
  model: string
) => ImageInputCapabilitySource | undefined

export interface ImageInputRequestFacts {
  providerType: string
  method: ImageTransportOperation
  /** Roles that actually carry at least one image part in this request. */
  roles: readonly MessageRole[]
  capability: unknown
  now?: number
}

/**
 * Full intersection for one physical attempt: model evidence ∩ transport
 * implementation ∩ message role. Delegates the evidence half to the shared
 * resolver so both sides cannot drift.
 */
/**
 * Host intersection for one (provider, capability) pair.
 *
 * #669 keeps absence → `unknown` for every non-Codex provider. Codex
 * Subscription has no per-model vision split and no models.dev row: a live
 * ChatGPT catalog entry has no `imageInput` field. When the V2 transport can
 * carry the image, that absence is `supported` so Luna and every other Codex
 * model match the pre-#669 path. Only a missing allowlist field is upgraded:
 * a present value that failed to parse is stored as `{ state: 'unknown' }` and
 * stays denied. Curated `unsupported` / dated evidence still wins. Never
 * invent models.dev rows.
 */
export function resolveHostImageInput(
  providerType: string,
  capability: unknown,
  options: { transportSupported: boolean; now?: number }
): ImageInputDecision {
  const decision = resolveImageInputCapability(capability, options)
  if (
    imageWireFamilyFor(providerType) === 'codex' &&
    options.transportSupported === true &&
    capability === undefined &&
    decision.state === 'unknown' &&
    decision.reason === 'model_unknown' &&
    decision.evidence === undefined
  ) {
    return { state: 'supported', reason: 'supported' }
  }
  return decision
}

export function decideImageInput(facts: ImageInputRequestFacts): ImageInputDecision {
  const transportSupported =
    facts.roles.length > 0 &&
    facts.roles.every(role => transportSupportsImageInput(facts.providerType, facts.method, role))
  return resolveHostImageInput(facts.providerType, facts.capability, {
    transportSupported,
    now: facts.now,
  })
}

/**
 * Message roles carrying at least one image part, in first-seen order. An
 * empty result means the request carries no image and the guard is a no-op.
 */
export function imageInputRolesFor(messages: readonly ChatMessage[]): MessageRole[] {
  const roles: MessageRole[] = []
  for (const message of messages) {
    if (!message.contentParts?.some(part => part.type === 'image')) continue
    if (!roles.includes(message.role)) roles.push(message.role)
  }
  return roles
}

/**
 * Operator/Desktop-facing explanation for a denied decision. States the real
 * (provider, model) that would have been called and the action to take; never
 * names internal evidence references or private endpoints.
 */
export function imageInputDenialMessage(
  decision: ImageInputDecision,
  target: { provider: string; model: string }
): string {
  const pair = `${target.provider}/${target.model}`
  const suffix = 'The rest of the message was not sent to the provider.'
  switch (decision.reason) {
    case 'transport_unsupported':
      return `The ${target.provider} transport path used for this operation cannot carry images for ${pair}. Remove the image or retry with a model whose chat path supports images. ${suffix}`
    case 'model_unsupported':
      return `Image input is not supported by ${pair}. Remove the image or choose a model with verified image support. ${suffix}`
    case 'model_unknown':
      return `Image input support for ${pair} is not verified. Remove the image or choose a model with verified image support. ${suffix}`
    case 'evidence_expired':
      return `Image input support for ${pair} expired${
        decision.validUntil ? ` on ${decision.validUntil}` : ''
      }. Refresh the capability evidence or choose another model. ${suffix}`
    case 'evidence_not_yet_valid':
      return `Image input support for ${pair} is not effective yet. Refresh the capability evidence or choose another model. ${suffix}`
    case 'supported':
      return `Image input is allowed for ${pair}.`
  }
}
