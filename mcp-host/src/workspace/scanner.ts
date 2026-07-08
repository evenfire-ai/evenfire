/**
 * Memory content scanner — defensive layer for MEMORY.md and memories/*.
 *
 * Background: WorkspaceService is a Pod-wide collective workspace. MEMORY.md /
 * memories/ content is NOT injected into the system prompt — the agent reads it
 * on demand via memory_read/memory_search. So the scanner protects the
 * *tool-read* path (a poisoned entry the agent later reads and may act on), and
 * the byte cap forces consolidation. (The prompt-feeding agent-writable surface
 * is `daily/*`, scanned separately via `scanWriteContent`; see F3.) The scanner
 * rejects writes that match patterns of prompt injection, exfiltration,
 * invisible Unicode, sensitive paths, or that would push the file past its cap.
 *
 * Rejection is structured (MemoryScanRejectionError) and reaches the agent
 * via the memory_write tool result so it can paraphrase and retry. The
 * scanner never truncates or rewrites content silently.
 *
 * See `.specs/mcp-hermes/implementation-plans/P4-memory-hardening.md` for the
 * full design rationale.
 */
import * as path from 'path'
import { Counter } from 'prom-client'
import safeRegex from 'safe-regex'

// ── Public types ────────────────────────────────────────────────────────────

export type RejectionReason =
  | 'sensitive_path'
  | 'exfiltration'
  | 'invisible_unicode'
  | 'system_reinjection'
  | 'size_cap'

export class MemoryScanRejectionError extends Error {
  constructor(
    public readonly reason: RejectionReason,
    public readonly pattern: string,
    public readonly bytesSeen: number,
    message?: string
  ) {
    super(message ?? defaultMessageFor(reason, pattern, bytesSeen))
    this.name = 'MemoryScanRejectionError'
  }
}

// ── Config (env-overridable) ────────────────────────────────────────────────

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const MEMORY_MD_MAX_BYTES = parsePositiveInt(
  process.env.CLERUM_MEMORY_MD_MAX_BYTES,
  8 * 1024
)

const scanEnabled = process.env.CLERUM_MEMORY_SCAN_ENABLED !== 'false'

// ── Patterns ────────────────────────────────────────────────────────────────

interface LabeledPattern {
  re: RegExp
  label: string
}

// Category 1: sensitive file paths the agent should never echo into memory.
// Word-boundary aware to avoid matching "environment", "shadow dom", etc.
const SENSITIVE_PATH_PATTERNS: ReadonlyArray<LabeledPattern> = [
  { re: /\.env(?:[.\-/\s]|$)/i, label: '.env' },
  { re: /(?:^|[\s/])\.ssh(?:[/\s]|$)/i, label: '.ssh' },
  { re: /~\/\.aws(?:[/\s]|$)/i, label: '~/.aws' },
  { re: /\/etc\/shadow\b/i, label: '/etc/shadow' },
  { re: /\bcredentials(?:\.json|\.yaml|\.yml)?\b/i, label: 'credentials' },
]

// Category 2: shell exfiltration shapes (curl/wget piping a secret variable).
// 200-char lookahead cap keeps regex linear (no catastrophic backtracking).
const EXFILTRATION_PATTERNS: ReadonlyArray<LabeledPattern> = [
  {
    re: /\b(?:curl|wget)\b[^\n]{0,200}\$\{?[A-Z_][A-Z0-9_]*\}?/i,
    label: 'curl/wget $VAR',
  },
]

// Category 3: invisible / non-rendering Unicode. Combined into a single
// character class for efficiency. Written with explicit \u escapes (+ /u flag)
// so the dangerous codepoints are auditable in source and the class is easy to
// extend. Coverage:
//   U+00AD              soft hyphen
//   U+115F U+1160       Hangul choseong/jungseong fillers
//   U+180E              Mongolian vowel separator
//   U+200B–U+200F       zero-width space/non-joiner/joiner + LRM/RLM
//   U+2028 U+2029       line / paragraph separator
//   U+202A–U+202E       bidi EMBEDDING / OVERRIDE (LRE/RLE/PDF/LRO/RLO)
//   U+2060–U+2064       word joiner + invisible math operators
//   U+2066–U+2069       bidi ISOLATE (LRI/RLI/FSI/PDI) — CVE-2021-42574 "Trojan Source"
//   U+3164              Hangul filler
//   U+FE00–U+FE0F       variation selectors
//   U+FEFF              BOM / zero-width no-break space
//   U+E0000–U+E007F     tag block (deprecated; abused to smuggle hidden text)
const INVISIBLE_UNICODE_RE: RegExp =
  /[\u00AD\u115F\u1160\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}]/u

// Category 4: prompt re-injection markers (chat templates, jailbreak phrases).
const SYSTEM_REINJECTION_PATTERNS: ReadonlyArray<LabeledPattern> = [
  { re: /<\/?system>/i, label: '<system>' },
  { re: /\[INST\]/i, label: '[INST]' },
  { re: /\[\/INST\]/i, label: '[/INST]' },
  { re: /<\|im_start\|>\s*system/i, label: '<|im_start|>system' },
  { re: /<\|im_end\|>/i, label: '<|im_end|>' },
  {
    re: /\bignore\s+(?:previous|prior|all)\s+(?:instructions|prompts)\b/i,
    label: 'ignore previous instructions',
  },
  {
    re: /\bdisregard\s+(?:previous|prior|all)\s+(?:instructions|prompts)\b/i,
    label: 'disregard previous instructions',
  },
  { re: /^new\s+instructions:\s*$/im, label: 'new instructions:' },
]

// Defensive: validate every regex with safe-regex at module load. If a future
// edit slips in a backtracking pattern, the process refuses to boot.
for (const arr of [SENSITIVE_PATH_PATTERNS, EXFILTRATION_PATTERNS, SYSTEM_REINJECTION_PATTERNS]) {
  for (const { re, label } of arr) {
    if (!safeRegex(re)) {
      throw new Error(`[workspace/scanner] unsafe regex for ${label}: ${re}`)
    }
  }
}
if (!safeRegex(INVISIBLE_UNICODE_RE)) {
  throw new Error(`[workspace/scanner] unsafe regex for invisible_unicode: ${INVISIBLE_UNICODE_RE}`)
}

// ── Metric ──────────────────────────────────────────────────────────────────

export const memoryScanRejectionsTotal = new Counter({
  name: 'clerum_memory_scan_rejections_total',
  help: 'Total memory writes rejected by the workspace content scanner.',
  labelNames: ['reason', 'pattern'] as const,
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeScanPath(relativePath: string): string {
  let normalized = path.posix.normalize(relativePath)
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.startsWith('/')) normalized = normalized.slice(1)
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

/**
 * Returns true for `MEMORY.md` (root) and any `memories/*` subpath. These are
 * the agent's durable notebook: scanned for injection + size-capped (the 8 KB
 * cap forces consolidation). Read by the agent via tools (NOT injected into the
 * system prompt — see the file header).
 */
export function isMemoryClassPath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const normalized = normalizeScanPath(relativePath)
  if (normalized === 'MEMORY.md') return true
  if (normalized.startsWith('memories/')) return true
  return false
}

/**
 * Returns true for daily logs (`daily/*`). These ALSO feed the system prompt
 * (last N days via `snapshotDailyLogs`) so they get the injection scan, but
 * they legitimately grow (per-turn notes + compaction archive) so they are NOT
 * size-capped — see `scanWriteContent`.
 */
export function isDailyLogPath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  return normalizeScanPath(relativePath).startsWith('daily/')
}

/**
 * Single policy for "content being written that may feed the system prompt".
 * Memory-class paths get the full scan (8 KB cap + injection patterns); daily
 * logs get the injection patterns WITHOUT the size cap. Everything else is a
 * no-op. Paths are relative to each WorkspaceService root, so this works
 * identically for the collective and per-user instances (F1).
 */
export function scanWriteContent(
  relativePath: string,
  content: string,
  resultingBytes: number
): void {
  if (isMemoryClassPath(relativePath)) {
    scanMemoryContent(content, resultingBytes)
  } else if (isDailyLogPath(relativePath)) {
    scanMemoryContent(content, resultingBytes, Number.POSITIVE_INFINITY)
  }
}

function defaultMessageFor(reason: RejectionReason, pattern: string, bytes: number): string {
  switch (reason) {
    case 'sensitive_path':
      return (
        `Memory write rejected: content references a sensitive path (${pattern}). ` +
        `Paraphrase the entry without raw paths to secrets.`
      )
    case 'exfiltration':
      return (
        `Memory write rejected: content looks like an exfiltration command (${pattern}). ` +
        `Memory is for durable facts, not commands.`
      )
    case 'invisible_unicode':
      return `Memory write rejected: content contains invisible Unicode characters.`
    case 'system_reinjection':
      return (
        `Memory write rejected: content contains markers that look like ` +
        `system-prompt re-injection (${pattern}). Paraphrase without those markers.`
      )
    case 'size_cap':
      return (
        `Memory write rejected: result would be ${bytes} bytes ` +
        `(max ${MEMORY_MD_MAX_BYTES}). Consolidate existing entries before adding new content.`
      )
  }
}

function bumpMetric(reason: RejectionReason, pattern: string): void {
  memoryScanRejectionsTotal.inc({ reason, pattern })
}

/**
 * Scans content destined for a memory-class file. Throws
 * MemoryScanRejectionError on the first violation. Order: cheapest checks
 * first (size cap), then string/regex scans.
 *
 * The size cap is enforced even when CLERUM_MEMORY_SCAN_ENABLED=false — it
 * is a structural safety bound, not an anti-injection rule.
 */
export function scanMemoryContent(
  content: string,
  resultingBytes: number,
  maxBytes: number = MEMORY_MD_MAX_BYTES
): void {
  if (resultingBytes > maxBytes) {
    bumpMetric('size_cap', '')
    throw new MemoryScanRejectionError('size_cap', '', resultingBytes)
  }

  if (!scanEnabled) return

  for (const { re, label } of SENSITIVE_PATH_PATTERNS) {
    if (re.test(content)) {
      bumpMetric('sensitive_path', label)
      throw new MemoryScanRejectionError('sensitive_path', label, resultingBytes)
    }
  }

  for (const { re, label } of EXFILTRATION_PATTERNS) {
    if (re.test(content)) {
      bumpMetric('exfiltration', label)
      throw new MemoryScanRejectionError('exfiltration', label, resultingBytes)
    }
  }

  if (INVISIBLE_UNICODE_RE.test(content)) {
    bumpMetric('invisible_unicode', 'zero-width/bidi/BOM')
    throw new MemoryScanRejectionError('invisible_unicode', 'zero-width/bidi/BOM', resultingBytes)
  }

  for (const { re, label } of SYSTEM_REINJECTION_PATTERNS) {
    if (re.test(content)) {
      bumpMetric('system_reinjection', label)
      throw new MemoryScanRejectionError('system_reinjection', label, resultingBytes)
    }
  }
}
