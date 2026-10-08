import type { ModelStepBlockedReason } from '../../../src/types'

export const MAX_VISIBLE_SESSIONS = 6
export const SESSION_PREVIEW_LIMIT = 5
/**
 * Distance (px) from the bottom within which a reader still follows the chat.
 * Beyond it, appended content must not pull them away from older history.
 */
export const CHAT_NEAR_BOTTOM_THRESHOLD_PX = 120

export const AGENT_ERROR_CODE_LABELS: Record<string, string> = {
  LLM_INSUFFICIENT_QUOTA: 'Out of Credits',
  LLM_RATE_LIMITED: 'Rate Limited',
  LLM_AUTHENTICATION_FAILED: 'Authentication Error',
  LLM_MODEL_OVERLOADED: 'Model Overloaded',
  LLM_CONTROL_PLANE_UNAVAILABLE: 'Control Plane Unavailable',
  LLM_MODEL_NOT_AVAILABLE: 'Model Not Available',
  LLM_CONTENT_FILTERED: 'Content Filtered',
  LLM_API_CALL_FAILED: 'Connection Error',
  LLM_UPSTREAM_REJECTED: 'Provider Rejected Request',
  LLM_TOOL_CALL_LIMIT_EXCEEDED: 'Too Many Tool Calls',
  LLM_STREAM_DURATION_EXCEEDED: 'Response Took Too Long',
  LLM_CONTEXT_LENGTH_EXCEEDED: 'Conversation Too Long',
  LLM_INVALID_RESPONSE: 'Invalid Model Response',
  LLM_IMAGE_INPUT_UNSUPPORTED: 'Image Input Unsupported',
  LLM_IMAGE_INPUT_UNKNOWN: 'Image Input Unverified',
  LLM_INVALID_ATTACHMENT: 'Invalid Attachment',
  LLM_MODEL_SELECTION_CONFLICT: 'Model Selection Changed',
  LLM_MODEL_NOT_ALLOWED: 'Model Not Allowed',
}

/** Action label of the model-step continuation (#1044); distinct from Resend. */
export const MODEL_STEP_RETRY_LABEL = 'Retry model step'

/** Why the Host refuses to continue a model-step checkpoint (#1043 contract). */
export const MODEL_STEP_BLOCKED_REASON_LABELS: Record<ModelStepBlockedReason, string> = {
  principal_mismatch: 'The signed-in account is not the one that started this turn.',
  host_mismatch: 'This turn belongs to a different Host.',
  grant_revoked: 'The tool access this turn used has been revoked.',
  model_unavailable: 'The model this turn used is no longer available.',
  budget_exhausted: 'The task budget for this turn is used up.',
  reference_unavailable: 'A file or reference this turn used is no longer available.',
}
