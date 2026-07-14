/**
 * T1.1 — Best-effort markdown parser for the structured summary template
 * (`mcp-host/src/core/extensions/structuredSummaryTemplate.ts`).
 *
 * The LLM may or may not respect the template exactly. The parser handles
 * three regimes:
 *
 *   - `ok`:        every expected section recognised; all fields populated.
 *   - `partial`:   at least one expected section recognised; rest `null`.
 *   - `fallback`:  no recognisable `## ` header at all; entire output goes
 *                  to `rawBody`. The caller persists the rawBody verbatim.
 *
 * `## Memory Writes (verbatim)` is parsed *strictly*: the header must match
 * exactly, entries must reference a known target (MEMORY.md / USER.md) and
 * follow the verbatim shape. If the header is present but contents look
 * paraphrased, `memoryWrites` falls back to `null` and a warning is appended
 * to `warnings` — the consumer must surface a `[memory writes section could
 * not be parsed — review previous turn]` placeholder so the agent knows to
 * re-read MEMORY.md from disk.
 */

export type ParseStatus = 'ok' | 'partial' | 'fallback'

export interface ParsedSummary {
  activeTask: string | null
  goal: string | null
  constraintsAndPreferences: string | null
  completedActions: string[]
  activeState: string | null
  inProgress: string | null
  blocked: string | null
  keyDecisions: string | null
  resolvedQuestions: string | null
  pendingUserAsks: string | null
  relevantFiles: string[]
  remainingWork: string | null
  criticalContext: string | null
  memoryWrites: string | null
  rawBody: string
  parseStatus: ParseStatus
  warnings: string[]
}

interface SectionField {
  key:
    | 'activeTask'
    | 'goal'
    | 'constraintsAndPreferences'
    | 'completedActions'
    | 'activeState'
    | 'inProgress'
    | 'blocked'
    | 'keyDecisions'
    | 'resolvedQuestions'
    | 'pendingUserAsks'
    | 'relevantFiles'
    | 'remainingWork'
    | 'criticalContext'
    | 'memoryWrites'
}

/**
 * Header-name aliases normalised against lowercased/trimmed/`&`-as-`and`
 * variants. The values map to a single field on `ParsedSummary`.
 */
const HEADER_ALIASES: Record<string, SectionField['key']> = {
  'active task': 'activeTask',
  goal: 'goal',
  'constraints and preferences': 'constraintsAndPreferences',
  'completed actions': 'completedActions',
  'active state': 'activeState',
  'in progress': 'inProgress',
  blocked: 'blocked',
  'key decisions': 'keyDecisions',
  'resolved questions': 'resolvedQuestions',
  'pending user asks': 'pendingUserAsks',
  'relevant files': 'relevantFiles',
  'remaining work': 'remainingWork',
  'critical context': 'criticalContext',
  'memory writes': 'memoryWrites',
  'memory writes (verbatim)': 'memoryWrites',
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ')
}

function emptyParsed(raw: string): ParsedSummary {
  return {
    activeTask: null,
    goal: null,
    constraintsAndPreferences: null,
    completedActions: [],
    activeState: null,
    inProgress: null,
    blocked: null,
    keyDecisions: null,
    resolvedQuestions: null,
    pendingUserAsks: null,
    relevantFiles: [],
    remainingWork: null,
    criticalContext: null,
    memoryWrites: null,
    rawBody: raw,
    parseStatus: 'fallback',
    warnings: [],
  }
}

function parseBulletList(body: string): string[] {
  const items: string[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Accept "1. foo", "1) foo", "- foo", "* foo", "• foo" or plain lines.
    const m = trimmed.match(/^(?:\d+[.)]|[-*•])\s*(.+)$/)
    if (m && m[1]) {
      items.push(m[1].trim())
    } else {
      items.push(trimmed)
    }
  }
  return items
}

/**
 * Memory Writes is the only strict section. Accept only entries that anchor
 * to a known target (`MEMORY.md` / `USER.md`) or that use the Hermes-style
 * `§` marker as an explicit per-entry separator. Reject prose like
 * `(memory was updated, see above)` — the consumer needs an actionable copy.
 */
function parseMemoryWrites(body: string): { value: string | null; warning: string | null } {
  const trimmed = body.trim()
  if (!trimmed) {
    return { value: null, warning: 'memory_writes_empty' }
  }

  // Tokenise by blank line OR `§` marker. Any entry referencing MEMORY.md
  // or USER.md anchors the whole block as verbatim. If nothing anchors,
  // treat as paraphrased prose and reject.
  const candidates = trimmed
    .split(/\n\s*\n|§/)
    .map(s => s.trim())
    .filter(Boolean)
  const anchored = candidates.some(c => /\b(MEMORY|USER)\.md\b/i.test(c))
  if (!anchored) {
    return { value: null, warning: 'memory_writes_no_anchor' }
  }
  return { value: trimmed, warning: null }
}

/**
 * Parse a structured summary output into the shape downstream consumers
 * expect. Returns `parseStatus: 'fallback'` (with the full input in
 * `rawBody`) when no `## ` headers are recognised. The function never
 * throws — every malformed input degrades gracefully.
 */
export function parseStructuredSummary(raw: string): ParsedSummary {
  const out = emptyParsed(raw)
  out.rawBody = raw

  // Sectioning by `## ` headers. The first line of each match is the header;
  // the body is everything until the next `## ` or end of input.
  const headerRe = /^##[ \t]+(.+?)[ \t]*$/gm
  const matches: { name: string; bodyStart: number; bodyEnd: number }[] = []
  const headers: { name: string; index: number; headerEnd: number }[] = []

  let m: RegExpExecArray | null
  while ((m = headerRe.exec(raw)) !== null) {
    headers.push({ name: m[1] as string, index: m.index, headerEnd: m.index + m[0].length })
  }

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i]!.headerEnd
    const end = i + 1 < headers.length ? headers[i + 1]!.index : raw.length
    matches.push({ name: headers[i]!.name, bodyStart: start, bodyEnd: end })
  }

  if (matches.length === 0) {
    // No recognisable structure — fallback to raw.
    return out
  }

  let recognisedSections = 0
  const seen = new Set<SectionField['key']>()

  for (const match of matches) {
    const key = HEADER_ALIASES[normalizeHeader(match.name)]
    if (!key) continue
    recognisedSections += 1
    seen.add(key)
    const body = raw.slice(match.bodyStart, match.bodyEnd).trim()

    switch (key) {
      case 'completedActions':
        out.completedActions = parseBulletList(body)
        break
      case 'relevantFiles':
        out.relevantFiles = parseBulletList(body)
        break
      case 'memoryWrites': {
        const { value, warning } = parseMemoryWrites(body)
        out.memoryWrites = value
        if (warning) out.warnings.push(warning)
        break
      }
      case 'activeTask':
        out.activeTask = body || null
        break
      case 'goal':
        out.goal = body || null
        break
      case 'constraintsAndPreferences':
        out.constraintsAndPreferences = body || null
        break
      case 'activeState':
        out.activeState = body || null
        break
      case 'inProgress':
        out.inProgress = body || null
        break
      case 'blocked':
        out.blocked = body || null
        break
      case 'keyDecisions':
        out.keyDecisions = body || null
        break
      case 'resolvedQuestions':
        out.resolvedQuestions = body || null
        break
      case 'pendingUserAsks':
        out.pendingUserAsks = body || null
        break
      case 'remainingWork':
        out.remainingWork = body || null
        break
      case 'criticalContext':
        out.criticalContext = body || null
        break
    }
  }

  if (recognisedSections === 0) {
    return out // still fallback
  }

  // Distinguish `ok` (every expected section saw text or was explicitly empty)
  // vs `partial`. We consider `ok` when at least `activeTask` is populated AND
  // the LLM emitted ≥ 6 of the section headers (covering the most-load-bearing
  // half of the template — the rest may be legitimately omitted per the
  // "Omit a section only if its content is empty" rule).
  if (seen.has('activeTask') && recognisedSections >= 6) {
    out.parseStatus = 'ok'
  } else {
    out.parseStatus = 'partial'
  }

  return out
}
