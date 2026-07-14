/**
 * T1.5 — Tool-result spillover types.
 *
 * Wire shape between the writer (`SpilloverStorage.maybePersist`), the
 * resolver (`FsSpilloverResolver`), the native read tool
 * (`clerum__spillover_read`), and the LLM message content.
 *
 * The spillover URI format is `spillover://<task_id>/<tool_call_id>.json`.
 * It is duplicated in two places:
 *   - `message.spillover_ref` (lateral field, O(1) for code) — Opción D, P.3.
 *   - inside the JSON-stringified summary in `message.content` — visible
 *     to the LLM so it can quote it when invoking `clerum__spillover_read`.
 */

/**
 * Summary written into the `role:'tool'` message `content` when a tool
 * output exceeds the threshold. The LLM sees this verbatim; the code path
 * reads `spillover_ref` directly off the message (lateral field).
 */
export interface SpilloverSummary {
  spillover_ref: string
  byte_size: number
  line_count: number
  content_type: string
  fingerprint_sha256: string
  head: string
  tail: string
  structure_hint: unknown | null
}

/**
 * Persisted blob on disk. `version: 1` reserves room for future evolution
 * (chunking, streaming refs) without breaking the resolver's load path.
 */
export interface SpilloverBlob {
  version: 1
  tool_call_id: string
  tool_name: string
  task_id: string
  created_at_ms: number
  byte_size: number
  line_count: number
  content_type: string
  fingerprint_sha256: string
  content: string
}

export interface SpilloverStorageOptions {
  workspacePath: string
  ttlMs: number
  thresholdBytes: number
  /** 0 disables the periodic sweep (lazy-only at boot). */
  gcIntervalMs: number
}

export interface MaybePersistArgs {
  taskId: string
  toolCallId: string
  toolName: string
  /** Sanitized content — i.e. the same string the LLM would have received inline. */
  content: string
  isError: boolean
}

export interface SweepResult {
  bytesFreed: number
  filesDeleted: number
}
