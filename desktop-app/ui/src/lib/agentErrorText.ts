/**
 * The user-facing body of an agent error (#1043).
 *
 * The Host reports every provider that cannot serve the request as
 * `LLM_MODEL_OVERLOADED` and describes the transport in its own message
 * (`proxy stream failed with provider_unavailable`). A code listed here gets a
 * fixed sentence instead; the Host message stays in the bubble's Details.
 */
export const AGENT_ERROR_CODE_SUMMARIES: Record<string, string> = {
  LLM_MODEL_OVERLOADED: 'The model provider could not complete this response.',
}

/** The body for `code`: its summary when it has one, else the Host message. */
export function agentErrorText(code: string | undefined, hostMessage: string): string {
  return (code ? AGENT_ERROR_CODE_SUMMARIES[code] : undefined) ?? hostMessage
}
