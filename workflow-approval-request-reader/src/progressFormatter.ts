export interface ProgressStep {
  toolCallId: string
  toolName: string
  displayName: string
  intentSummary: string
  iteration: number
  stepIndex: number
  totalSteps: number
  state: 'running' | 'completed' | 'error'
  durationMs?: number
  errorSummary?: string
}

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

function formatStepLine(step: ProgressStep): string {
  const icon = step.state === 'completed' ? '✓' : step.state === 'running' ? '●' : '✗'
  const fn = toolFn(step)
  const label = fn ? `${step.displayName} · ${fn}` : step.displayName

  if (step.state === 'completed' && step.durationMs != null) {
    return `${icon} ${label}  ${formatDuration(step.durationMs)}`
  }
  if (step.state === 'running') {
    return `${icon} ${label}  running...`
  }
  return `${icon} ${label}  ${step.errorSummary || 'error'}`
}

export function formatProcessingMessage(): string {
  return '⏳ Processing your request...'
}

export function formatProgressUpdate(steps: ProgressStep[]): string {
  const lines: string[] = [formatProcessingMessage(), '']
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

  const errorCount = steps.filter(step => step.state === 'error').length
  const totalDuration = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
  const toolNames = [...new Set(steps.map(step => step.displayName))].join(', ')
  const icon = errorCount > 0 ? '⚠' : '✓'

  const summary = `${icon} ${steps.length} tool${steps.length > 1 ? 's' : ''} used · ${toolNames} · ${formatDuration(totalDuration)}`
  const full = `${summary}\n\n${response}`

  if (full.length <= MAX_MESSAGE_LENGTH) return full

  if (response.length > MAX_MESSAGE_LENGTH - 4) {
    return response.substring(0, MAX_MESSAGE_LENGTH - 3) + '...'
  }
  return response
}
