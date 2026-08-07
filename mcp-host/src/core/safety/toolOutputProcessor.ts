import { Safety, ToolOutputProcessor } from '../interfaces'
import { ToolOutput, ValidationResult } from '../types'

/**
 * Default ToolOutputProcessor that delegates to Safety.
 *
 * This is the extension point where custom logging, metrics,
 * or transformations can be added while still calling Safety.
 */
export class DefaultToolOutputProcessor implements ToolOutputProcessor {
  constructor(private readonly safety: Safety) {}

  beforeExecution(toolName: string, params: Record<string, unknown>): ValidationResult {
    return this.safety.validateToolParams(toolName, params)
  }

  afterExecution(toolName: string, output: ToolOutput): string {
    // Safety sandwich: sanitize -> wrap
    const sanitized = this.safety.sanitizeOutput(toolName, output.content)
    return this.safety.wrapForLlm(toolName, sanitized.content, sanitized.was_modified)
  }
}
