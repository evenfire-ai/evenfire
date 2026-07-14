/**
 * T1.5 §4.4 — Structure hints attached to spillover summaries.
 *
 * Strict rules (plan §4.4):
 *   - Never call the LLM. Everything is regex / shape inspection.
 *   - Wrap each generator in try/catch; on failure return `null` (do not
 *     "invent" hints).
 *   - Cheap: bounded line scan (first 50 lines) for source code,
 *     bounded JSON parse for HTTP/JSON outputs.
 *
 * The hint is **advisory** for the LLM. It MUST never carry secrets or
 * full content — head/tail already cover that.
 */

const HEAD_LINES_FOR_SCAN = 50
const MAX_SYMBOLS = 20
const MAX_TOP_LEVEL_KEYS = 10

interface FileReadHint {
  language: string
  top_level: string[]
}

interface HttpHint {
  status?: number
  content_type?: string
  top_level_keys?: string[]
}

interface ShellHint {
  exit_code?: number
  looks_like_error?: boolean
}

const LANGUAGE_PATTERNS: Record<string, { regex: RegExp; language: string }> = {
  '.ts': {
    regex:
      /^\s*(?:export\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/,
    language: 'typescript',
  },
  '.tsx': {
    regex:
      /^\s*(?:export\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/,
    language: 'typescript',
  },
  '.js': {
    regex: /^\s*(?:export\s+)?(?:async\s+)?(function|class|const|let|var)\s+(\w+)/,
    language: 'javascript',
  },
  '.jsx': {
    regex: /^\s*(?:export\s+)?(?:async\s+)?(function|class|const|let|var)\s+(\w+)/,
    language: 'javascript',
  },
  '.py': {
    regex: /^\s*(class|def|async\s+def)\s+(\w+)/,
    language: 'python',
  },
  '.rs': {
    regex: /^\s*(?:pub\s+)?(fn|struct|enum|trait|impl)\s+(\w+)/,
    language: 'rust',
  },
  '.go': {
    regex: /^\s*func\s+(?:\(\s*\w+\s+[\w*]+\s*\)\s+)?(\w+)/,
    language: 'go',
  },
}

function inferExtension(toolName: string, params?: Record<string, unknown>): string | null {
  if (toolName === 'file_read' && params && typeof params['path'] === 'string') {
    const idx = (params['path'] as string).lastIndexOf('.')
    if (idx >= 0) return (params['path'] as string).slice(idx).toLowerCase()
  }
  return null
}

function topLevelJsonKeys(content: string): string[] | null {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).slice(0, MAX_TOP_LEVEL_KEYS)
    }
    return null
  } catch {
    return null
  }
}

function fileReadHint(content: string, extension: string | null): FileReadHint | null {
  // Markdown headings.
  if (extension === '.md') {
    const headings: string[] = []
    const lines = content.split(/\r?\n/).slice(0, HEAD_LINES_FOR_SCAN)
    for (const line of lines) {
      const m = line.match(/^#\s+(.+)$/)
      if (m) headings.push(m[1].trim().slice(0, 80))
      if (headings.length >= MAX_SYMBOLS) break
    }
    if (headings.length === 0) return null
    return { language: 'markdown', top_level: headings }
  }

  // JSON: top-level keys when parseable.
  if (extension === '.json') {
    const keys = topLevelJsonKeys(content)
    if (!keys) return null
    return { language: 'json', top_level: keys }
  }

  // YAML: top-level keys ("^[a-zA-Z_][\w-]*\s*:") in first 50 lines.
  if (extension === '.yaml' || extension === '.yml') {
    const keys: string[] = []
    const lines = content.split(/\r?\n/).slice(0, HEAD_LINES_FOR_SCAN)
    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][\w-]*)\s*:/)
      if (m) keys.push(m[1])
      if (keys.length >= MAX_TOP_LEVEL_KEYS) break
    }
    if (keys.length === 0) return null
    return { language: 'yaml', top_level: keys }
  }

  // Source code patterns.
  if (extension && LANGUAGE_PATTERNS[extension]) {
    const { regex, language } = LANGUAGE_PATTERNS[extension]
    const symbols: string[] = []
    const lines = content.split(/\r?\n/).slice(0, HEAD_LINES_FOR_SCAN)
    for (const line of lines) {
      const m = line.match(regex)
      if (m) {
        const kind = m[1] ?? 'symbol'
        const name = m[2] ?? m[1] ?? '?'
        symbols.push(`${kind} ${name}`)
      }
      if (symbols.length >= MAX_SYMBOLS) break
    }
    if (symbols.length === 0) return null
    return { language, top_level: symbols }
  }

  return null
}

function httpHint(content: string, contentType: string): HttpHint | null {
  // Try parse JSON body when content_type suggests JSON.
  const hint: HttpHint = {}
  if (contentType === 'application/json') {
    const keys = topLevelJsonKeys(content)
    if (keys) hint.top_level_keys = keys
    hint.content_type = contentType
  }
  // Try to pluck "HTTP/1.1 200 OK"-style first line if present (some tools prepend status).
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const statusMatch = firstLine.match(/^HTTP\/[\d.]+\s+(\d{3})/)
  if (statusMatch) hint.status = Number(statusMatch[1])
  return Object.keys(hint).length === 0 ? null : hint
}

function shellHint(content: string): ShellHint | null {
  const hint: ShellHint = {}
  // Errorish heuristics on the *first* line — same as the LLM would skim.
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  if (
    /^(Traceback|Error|error|panic|fatal:|Exception:)/i.test(firstLine) ||
    /^[A-Z][\w.]*Error:/.test(firstLine)
  ) {
    hint.looks_like_error = true
  }
  // Exit code (some shell tools append "Exit: <N>").
  const exitMatch = content.match(/(?:^|\n)\s*(?:exit code|exit):\s*(\d+)/i)
  if (exitMatch) hint.exit_code = Number(exitMatch[1])
  return Object.keys(hint).length === 0 ? null : hint
}

/**
 * Public entry point. Dispatches by tool name + content_type.
 */
export function generateStructureHint(
  toolName: string,
  content: string,
  contentType: string,
  params?: Record<string, unknown>
): unknown | null {
  try {
    if (toolName === 'file_read') {
      const ext = inferExtension(toolName, params)
      return fileReadHint(content, ext)
    }
    if (toolName === 'http_request') {
      return httpHint(content, contentType)
    }
    if (toolName === 'shell_exec' || toolName === 'shell') {
      return shellHint(content)
    }
    // JSON content from any tool — best-effort top-level keys.
    if (contentType === 'application/json') {
      const keys = topLevelJsonKeys(content)
      if (keys) return { top_level_keys: keys }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Heuristic content_type inference. Public for the storage layer; deliberately
 * dumb so callers can override when they know better (e.g. http_request tool
 * could pluck the real Content-Type header from a wrapped envelope).
 */
export function inferContentType(toolName: string, content: string): string {
  if (toolName === 'file_read') {
    const trimmed = content.trimStart()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
        return 'application/json'
      } catch {
        // fall through
      }
    }
    if (/^#\s+/m.test(content)) return 'text/markdown'
    return 'text/plain'
  }
  if (toolName === 'http_request') {
    const trimmed = content.trimStart()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
        return 'application/json'
      } catch {
        // fall through
      }
    }
    return 'text/plain'
  }
  return 'text/plain'
}
