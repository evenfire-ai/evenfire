import type { ProgressStep } from './types'

const MAX_MESSAGE_LENGTH = 4096

function toolFn(step: ProgressStep): string {
  const sep = step.toolName.indexOf('__')
  if (sep > 0) return step.toolName.substring(sep + 2)
  if (step.displayName !== step.toolName) return step.toolName
  return ''
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Render a tool failure in our own words. The raw summary can contain a
 * JSON-RPC envelope, an internal error code, or arbitrary provider text, none
 * of which belongs in a chat client. Classify into a closed vocabulary and
 * render our sentence; anything unrecognised degrades to generic. The full
 * text stays in logs and traces.
 */
export function describeToolError(errorSummary: string | undefined): string {
  const raw = (errorSummary ?? '').toLowerCase()
  if (!raw) return 'unavailable.'
  // Anchored so this does not fire on "author" (bare auth) or a millisecond
  // count that happens to contain "401"/"403" (bare digits).
  if (
    /unauthoriz|unauthenticat|authentication|authorization|credential|forbidden|\b401\b|\b403\b/.test(
      raw
    )
  ) {
    return 'unavailable (authentication problem). Ask your administrator.'
  }
  if (/timed out|timeout|etimedout|deadline/.test(raw)) return 'unavailable (timed out).'
  // \b-anchored for the same reason as 401/403 above: bare "429" matched inside
  // "4291ms" and bare "404" inside "4041ms", so a duration classified as a rate
  // limit or a missing resource.
  if (/rate limit|\b429\b|too many requests/.test(raw)) return 'unavailable (rate limited).'
  if (/not found|\b404\b|no such/.test(raw)) return 'unavailable (not found).'
  // Checked before the invalid-input category below: when a message carries
  // both a size-limit signal and generic "invalid" wording (e.g. "invalid
  // request, payload too large"), the size limit is the more specific and
  // more useful diagnosis, so it must win deterministically.
  if (/too large|\b413\b/.test(raw)) return 'unavailable (too large).'
  // Anchored on whole words so this does not fire on "invalidated" (bare
  // "invalid"), the same way the authentication check above must not fire on
  // "author".
  if (/\binvalid\b|\bmalformed\b|\bbad request\b|\b400\b/.test(raw)) {
    return 'unavailable (invalid input).'
  }
  return 'unavailable.'
}

function formatStepLine(step: ProgressStep): string {
  const icon = step.state === 'completed' ? '✓' : step.state === 'running' ? '●' : '✗'
  const name = step.displayName
  const fn = toolFn(step)
  const label = fn ? `${name} · ${fn}` : name

  if (step.state === 'completed' && step.durationMs != null) {
    return `${icon} ${label}  ${formatDuration(step.durationMs)}`
  }
  if (step.state === 'running') {
    return `${icon} ${label}  running...`
  }
  return `${icon} ${label}  ${describeToolError(step.errorSummary)}`
}

export function formatProgressUpdate(steps: ProgressStep[]): string {
  const lines: string[] = ['⏳ Processing your request...', '']
  let prevIteration: number | undefined

  for (const step of steps) {
    if (prevIteration !== undefined && step.iteration !== prevIteration) {
      lines.push('── Thinking further... ──')
    }
    prevIteration = step.iteration
    lines.push(formatStepLine(step))
  }

  return lines.join('\n')
}

export function formatFinalMessage(steps: ProgressStep[], response: string): string {
  if (steps.length === 0) return response

  const errorCount = steps.filter(s => s.state === 'error').length
  const totalDuration = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
  const toolNames = [...new Set(steps.map(s => s.displayName))].join(', ')
  const icon = errorCount > 0 ? '⚠' : '✓'

  const summary = `${icon} ${steps.length} tool${steps.length > 1 ? 's' : ''} used · ${toolNames} · ${formatDuration(totalDuration)}`
  const full = `${summary}\n\n${response}`

  if (full.length <= MAX_MESSAGE_LENGTH) return full

  if (response.length > MAX_MESSAGE_LENGTH - 4) {
    return response.substring(0, MAX_MESSAGE_LENGTH - 3) + '...'
  }
  return response
}
