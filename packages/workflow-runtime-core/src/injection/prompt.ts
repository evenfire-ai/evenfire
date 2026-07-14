import type { StepSpec } from '../config-loader/types'

export const DEFAULT_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS = 8192
export const MIN_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS = 1024
export const MAX_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS = 65536

export interface PromptContext {
  step: StepSpec
  previousOutputs: Record<string, unknown>
  soul?: string
  workflowName?: string
}

export function getPreviousOutputPromptMaxChars(
  envValue = process.env.CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS
): number {
  if (envValue === undefined || envValue.trim() === '') {
    return DEFAULT_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS
  }
  const parsed = Number(envValue)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS ||
    parsed > MAX_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS
  ) {
    throw new Error(
      `Invalid CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS="${envValue}" (must be an integer between ${MIN_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS} and ${MAX_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS})`
    )
  }
  return parsed
}

const RUNTIME_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS = getPreviousOutputPromptMaxChars()

export function renderPrompt(
  template: string,
  context: PromptContext,
  previousOutputMaxChars = RUNTIME_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const trimmed = key.trim()

    // {{workflow:name}}
    if (trimmed === 'workflow:name') {
      return context.workflowName ?? '{{workflow:name}}'
    }

    // {{step-id:output}}
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) return `{{${trimmed}}}`

    const stepId = trimmed.substring(0, colonIdx)
    const field = trimmed.substring(colonIdx + 1)

    if (field === 'output' && stepId in context.previousOutputs) {
      const value = context.previousOutputs[stepId]
      const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
      // Security I-02 fix: bound previous step output and wrap it in a structural
      // delimiter. Full outputs stay in /output artifacts, never prompt interpolation.
      const isTruncated = raw.length > previousOutputMaxChars
      const truncated = isTruncated ? raw.slice(0, previousOutputMaxChars) : raw
      const truncationAttrs = isTruncated
        ? ` truncated="true" original-chars="${raw.length}" preview-chars="${previousOutputMaxChars}"`
        : ''
      return `<step-output id="${stepId}" data-only="true"${truncationAttrs}>\n${truncated}\n</step-output>`
    }

    // {{soul:content}}
    if (stepId === 'soul' && field === 'content' && context.soul) {
      return context.soul
    }

    // Unresolved — escape rather than throw
    return `{{${trimmed}}}`
  })
}
