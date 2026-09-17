/**
 * Image-input capability for ONE model, shared by the Desktop main process (wire
 * validation) and the renderer (composer/model-selector guards). Runtime-safe
 * module: the renderer imports it directly, the same way it imports
 * `chatMessageMerge`.
 *
 * Scope: this module only VALIDATES the decision the host projected. It never
 * recomputes model, transport or policy capability, and there is deliberately no
 * provider-based fallback — capability comes from the host, never from the
 * provider id, the model name, or OpenAI compatibility.
 *
 * `state` is the only authorization-relevant field. Images may be attached only
 * when the host projected `supported` with evidence that has not expired.
 * Anything missing, malformed or expired normalizes to `unknown`: the model
 * stays selectable for text and image attachments are blocked with an explicit
 * reason. Host-provided reasons are preserved verbatim; the local normalization
 * reasons are `model_unknown` and `evidence_expired`.
 */

export type ImageInputState = 'supported' | 'unsupported' | 'unknown'

export interface ImageInputDecision {
  state: ImageInputState
  /** Stable, machine-readable reason token (never user copy). */
  reason: string
  /** ISO timestamp after which the evidence must be re-evaluated as unknown. */
  validUntil?: string
  evidence?: {
    source: 'curated' | 'discovery'
    reference: string
    checkedAt: string
    validUntil?: string
  }
}

/** Local normalization reasons. Host-provided reasons are preserved as-is. */
export const IMAGE_INPUT_LOCAL_REASON = {
  /** No decision projected, malformed decision, or model absent from the catalog. */
  modelUnknown: 'model_unknown',
  /** Evidence existed but its `validUntil` already passed. */
  evidenceExpired: 'evidence_expired',
} as const

const IMAGE_INPUT_STATES: readonly ImageInputState[] = ['supported', 'unsupported', 'unknown']

function modelUnknown(): ImageInputDecision {
  return { state: 'unknown', reason: IMAGE_INPUT_LOCAL_REASON.modelUnknown }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeReason(rawReason: unknown, state: ImageInputState): string {
  if (typeof rawReason === 'string') {
    const trimmed = rawReason.trim()
    if (trimmed) return trimmed
  }
  if (state === 'supported') return 'image_input_supported'
  if (state === 'unsupported') return 'image_input_unsupported'
  return IMAGE_INPUT_LOCAL_REASON.modelUnknown
}

/**
 * Normalizes an untrusted wire value into a decision. Missing or malformed input
 * becomes `unknown` (never `unsupported`, so the UI can tell "not verified" from
 * "known to be text-only"). A malformed `validUntil` is treated as malformed
 * evidence rather than silently dropped: dropping it would turn an expiring
 * approval into a permanent one.
 */
export function normalizeImageInputDecision(raw: unknown): ImageInputDecision {
  if (!isPlainObject(raw)) return modelUnknown()

  const state = raw.state
  if (typeof state !== 'string' || !IMAGE_INPUT_STATES.includes(state as ImageInputState)) {
    return modelUnknown()
  }

  const normalizedState = state as ImageInputState
  if (typeof raw.reason !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(raw.reason))
    return modelUnknown()
  const decision: ImageInputDecision = {
    state: normalizedState,
    reason: normalizeReason(raw.reason, normalizedState),
  }

  if (raw.validUntil !== undefined) {
    if (typeof raw.validUntil !== 'string' || Number.isNaN(Date.parse(raw.validUntil))) {
      return modelUnknown()
    }
    decision.validUntil = raw.validUntil
  }

  if (raw.evidence !== undefined) {
    const evidence = raw.evidence
    if (
      !isPlainObject(evidence) ||
      !['curated', 'discovery'].includes(String(evidence.source)) ||
      typeof evidence.reference !== 'string' ||
      !evidence.reference.trim() ||
      evidence.reference.length > 1024 ||
      typeof evidence.checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(evidence.checkedAt)) ||
      (evidence.validUntil !== undefined &&
        (typeof evidence.validUntil !== 'string' ||
          !Number.isFinite(Date.parse(evidence.validUntil))))
    ) {
      return modelUnknown()
    }
    decision.evidence = {
      source: evidence.source as 'curated' | 'discovery',
      reference: evidence.reference,
      checkedAt: evidence.checkedAt,
      ...(evidence.validUntil === undefined ? {} : { validUntil: evidence.validUntil as string }),
    }
    // The host emits the same bound in both fields. Never turn a mismatched
    // expiring decision into a permanent approval by dropping its bound.
    if (decision.evidence.validUntil && decision.evidence.validUntil !== decision.validUntil)
      return modelUnknown()
  }

  return decision
}

/** True when the decision still authorizes images at `nowMs`. */
export function isImageInputDecisionValid(
  decision: ImageInputDecision,
  nowMs: number = Date.now()
): boolean {
  if (!decision.validUntil) return true
  const expiresAt = Date.parse(decision.validUntil)
  if (Number.isNaN(expiresAt)) return false
  return expiresAt > nowMs
}

/**
 * Normalizes AND re-evaluates freshness. This is the function every guard uses:
 * an expired approval reads as `unknown` with `evidence_expired` at each
 * attempt, without waiting for a ConfigMap/catalog change.
 */
export function resolveImageInputDecision(
  raw: unknown,
  nowMs: number = Date.now()
): ImageInputDecision {
  const decision = normalizeImageInputDecision(raw)
  if (decision.state === 'unknown') return decision
  if (
    decision.state === 'unsupported' &&
    (decision.reason === 'transport_unsupported' || decision.reason === 'policy_denied')
  )
    return decision
  if (!isImageInputDecisionValid(decision, nowMs)) {
    return {
      state: 'unknown',
      reason: IMAGE_INPUT_LOCAL_REASON.evidenceExpired,
      validUntil: decision.validUntil,
      ...(decision.evidence ? { evidence: decision.evidence } : {}),
    }
  }
  return decision
}

/** Minimal model-option shape needed to resolve the effective capability. */
export interface ImageInputModelOption {
  name: string
  imageInput?: unknown
}

/**
 * Resolves the capability of the model that will actually be requested. The
 * caller must pass the effective model (confirmed selection, pending intent, or
 * host default) — never a provider id and never `servedBy`.
 */
export function resolveModelImageInput(
  models: readonly ImageInputModelOption[] | null | undefined,
  effectiveModel: string | null | undefined,
  nowMs: number = Date.now()
): ImageInputDecision {
  const wanted = typeof effectiveModel === 'string' ? effectiveModel.trim() : ''
  if (!wanted) return modelUnknown()
  const option = (models ?? []).find(model => model?.name === wanted)
  if (!option) return modelUnknown()
  return resolveImageInputDecision(option.imageInput, nowMs)
}

/** Only `supported` authorizes attaching images. */
export function canSendImagesWith(decision: ImageInputDecision): boolean {
  return decision.state === 'supported'
}

/**
 * User-facing explanation for a blocking decision; `null` when images are
 * allowed. Kept here so the composer, the paste/drop handlers and the send-time
 * guard show identical copy.
 */
export function imageInputBlockMessage(
  effectiveModel: string | null | undefined,
  decision: ImageInputDecision
): string | null {
  if (canSendImagesWith(decision)) return null
  const label =
    typeof effectiveModel === 'string' && effectiveModel.trim()
      ? effectiveModel
      : 'the selected model'
  if (decision.state === 'unsupported') {
    return `Image attachments are not supported by model "${label}". Switch to a model with image input support before attaching images.`
  }
  return `Image input is not verified for model "${label}" yet. Switch to a model with verified image input support before attaching images.`
}
