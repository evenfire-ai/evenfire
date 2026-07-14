import type { Safety } from '../../interfaces.js'

// Pass-through Safety for tests that exercise reporter/agent plumbing without exercising redaction.
export const NoopSafety: Safety = {
  validateInput: () => ({ is_valid: true, errors: [] }),
  validateToolParams: () => ({ is_valid: true, errors: [] }),
  sanitizeOutput: (_toolName, output) => ({
    content: output,
    was_modified: false,
    warnings: [],
  }),
  wrapForLlm: (_toolName, content) => content,
}
