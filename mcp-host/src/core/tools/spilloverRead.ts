/**
 * T1.5 — `clerum__spillover_read` native tool.
 *
 * When `executeSingleTool` decides a tool output is too large to ship inline,
 * it writes the blob to `${WORKSPACE}/spillover/<task_id>/<tool_call_id>.json`
 * and embeds a `SpilloverSummary` in the `tool` message. The agent calls
 * this tool with `ref` (and optionally a `[start, end)` byte range) to fetch
 * the full content on demand.
 *
 * Important: this tool itself NEVER spills its own output (excepción §4.1 of
 * the plan). The check lives in `executeSingleTool` and is keyed by tool name.
 */
import { Tool } from '../interfaces'
import { SpilloverStorage, clerumSpilloverReadsTotal } from '../spillover'
import { ToolOutput } from '../types'

export class SpilloverReadTool implements Tool {
  constructor(private readonly storage: SpilloverStorage) {}

  name(): string {
    return 'clerum__spillover_read'
  }

  description(): string {
    return (
      'Fetch the full content (or a byte range) of a tool result that was ' +
      'spilled to disk. Use the `spillover_ref` value from a previous tool ' +
      'message whose `content` included a `spillover_ref` field. Optionally ' +
      'pass a `range: { start, end }` to read a `[start, end)` byte window.'
    )
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'The spillover URI: "spillover://<task_id>/<tool_call_id>.json".',
        },
        range: {
          type: 'object',
          description: 'Optional byte range [start, end). If omitted, returns the full content.',
          properties: {
            start: { type: 'integer', minimum: 0 },
            end: { type: 'integer', minimum: 1 },
          },
          required: ['start', 'end'],
        },
      },
      required: ['ref'],
    }
  }

  requiresSanitization(): boolean {
    // The blob can contain secrets the global sanitizer wants to redact;
    // matches `file_read` which is sanitized for the same reason.
    return true
  }

  requiresApproval(): boolean {
    // The original tool already passed (or didn't need) approval. Reading
    // back the persisted result is not a fresh side effect.
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    const ref = typeof params.ref === 'string' ? (params.ref as string) : null
    const rawRange = params.range
    const range =
      rawRange && typeof rawRange === 'object' && rawRange !== null
        ? (rawRange as { start?: unknown; end?: unknown })
        : null

    if (!ref) {
      return {
        content: 'Error: missing or invalid `ref` parameter.',
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }

    const blob = await this.storage.load(ref)
    if (!blob) {
      return {
        content: `Error: spillover blob ${ref} not found or expired.`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }

    if (range !== null) {
      const rangeStart = range.start
      const rangeEnd = range.end
      if (
        typeof rangeStart !== 'number' ||
        typeof rangeEnd !== 'number' ||
        !Number.isInteger(rangeStart) ||
        !Number.isInteger(rangeEnd) ||
        rangeStart < 0 ||
        rangeEnd <= rangeStart ||
        rangeEnd > blob.byte_size
      ) {
        clerumSpilloverReadsTotal?.inc({ with_range: 'true' })
        return {
          content: `Error: invalid range [${String(rangeStart)}, ${String(rangeEnd)}) for byte_size=${blob.byte_size}.`,
          duration_ms: Date.now() - start,
          is_error: true,
        }
      }
      const slice = Buffer.from(blob.content, 'utf8')
        .subarray(rangeStart, rangeEnd)
        .toString('utf8')
      clerumSpilloverReadsTotal?.inc({ with_range: 'true' })
      return {
        content: slice,
        duration_ms: Date.now() - start,
        is_error: false,
      }
    }

    clerumSpilloverReadsTotal?.inc({ with_range: 'false' })
    return {
      content: blob.content,
      duration_ms: Date.now() - start,
      is_error: false,
    }
  }
}
