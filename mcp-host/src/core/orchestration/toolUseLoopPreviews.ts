import type { OutputPreview } from '../../progress/types.js'

const INPUT_PREVIEW_KEYS: Record<string, string> = {
  shell_exec: 'command',
  memory_read: 'key',
  memory_write: 'key',
}

export function extractInputPreview(
  toolName: string,
  args: Record<string, unknown>
): string | undefined {
  const key = INPUT_PREVIEW_KEYS[toolName]
  if (key && typeof args[key] === 'string') {
    const val = args[key] as string
    return val.length > 200 ? val.slice(0, 197) + '...' : val
  }
  if (toolName.includes('__')) {
    const firstStr = Object.values(args).find(v => typeof v === 'string') as string | undefined
    if (firstStr) return firstStr.length > 200 ? firstStr.slice(0, 197) + '...' : firstStr
  }
  return undefined
}

const HEAD_LINES = 3
const TAIL_LINES = 10
const MAX_LINE_LENGTH = 200

export function buildOutputPreview(content: string): OutputPreview | undefined {
  if (!content) return undefined

  const lines = content
    .split('\n')
    .map(l => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH - 3) + '...' : l))
  const totalLines = lines.length

  if (totalLines <= HEAD_LINES + TAIL_LINES) {
    return { headLines: lines, tailLines: [], totalLines, truncated: false }
  }

  return {
    headLines: lines.slice(0, HEAD_LINES),
    tailLines: lines.slice(-TAIL_LINES),
    totalLines,
    truncated: true,
  }
}
