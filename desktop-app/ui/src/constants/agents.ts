export const MAX_VISIBLE_SESSIONS = 6
export const SESSION_PREVIEW_LIMIT = 9
export const CHAT_NEAR_BOTTOM_THRESHOLD_PX = 120

export const AGENT_ERROR_CODE_LABELS: Record<string, string> = {
  LLM_INSUFFICIENT_QUOTA: 'Out of Credits',
  LLM_RATE_LIMITED: 'Rate Limited',
  LLM_AUTHENTICATION_FAILED: 'Authentication Error',
  LLM_MODEL_OVERLOADED: 'Model Overloaded',
  LLM_MODEL_NOT_AVAILABLE: 'Model Not Available',
  LLM_CONTENT_FILTERED: 'Content Filtered',
  LLM_API_CALL_FAILED: 'Connection Error',
}
