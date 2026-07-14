/**
 * Pure functions for cleaning LLM text output before delivering to users.
 */

/**
 * Strip <thinking>...</thinking> and <think>...</think> blocks from LLM output.
 *
 * Handles unclosed tags by truncating from the opening tag.
 */
export function stripThinkingTags(text: string): string {
  // Handle complete tags first (greedy match)
  let result = text.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/gi, '')

  // Handle unclosed tags — remove from opening tag to end
  const unclosedIndex = result.search(/<(?:thinking|think)>/i)
  if (unclosedIndex !== -1) {
    result = result.substring(0, unclosedIndex)
  }

  return result
}

/**
 * Strip common reasoning preamble patterns at the start of the response.
 *
 * Only strips if the pattern appears at the START (after optional whitespace)
 * to avoid removing legitimate mid-content text.
 */
export function stripReasoningPatterns(text: string): string {
  const preamblePatterns = [
    /^\s*let me think(?:\s+about this)?[.!…]*\s*/i,
    /^\s*i'?ll think(?:\s+through this)?[.!…]*\s*/i,
    /^\s*thinking(?:\s+about this)?[.!…]*\s*/i,
    /^\s*let me analyze[.!…]*\s*/i,
    /^\s*i need to consider[.!…]*\s*/i,
    /^\s*let me (?:look|check|review|examine)[.!…]*\s*/i,
  ]

  let result = text
  for (const pattern of preamblePatterns) {
    result = result.replace(pattern, '')
  }
  return result
}

/**
 * Full cleaning pipeline.
 * Order: strip thinking tags -> strip reasoning patterns -> trim whitespace.
 * Idempotent.
 */
export function cleanResponse(text: string): string {
  let result = text
  result = stripThinkingTags(result)
  const thinkingStripped = result !== text
  const beforePatterns = result
  result = stripReasoningPatterns(result)
  const patternsStripped = result !== beforePatterns
  result = result.trim()
  if (thinkingStripped || patternsStripped) {
    console.log(
      `[NewCore:ResponseCleaner] cleanResponse → thinkingStripped=${thinkingStripped}, patternsStripped=${patternsStripped}, length=${text.length}→${result.length}`
    )
  }
  return result
}

/**
 * Extract JSON from LLM response text.
 * Tries: raw parse, code blocks, first {...} or [...] pattern.
 * Returns null if no valid JSON found.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  // Try full text first
  try {
    return JSON.parse(text)
  } catch {
    // Look for JSON in code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim())
      } catch {
        // fall through
      }
    }

    // Look for first { ... } or [ ... ] pattern
    const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1])
      } catch {
        // fall through
      }
    }

    return null
  }
}
