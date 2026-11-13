/**
 * Tool-result spillover for agentic workflow steps.
 *
 * `WorkflowService.executeStep` pastes every tool result into the prompt and
 * resends it on each iteration. This module keeps a result at or above the
 * threshold in this process's memory for the length of the step execution,
 * and the model receives the summary the first-party store gives (head, tail,
 * size, structure hint) plus a `spillover_ref` it can read back by byte range
 * with `clerum__spillover_read`. Refs are `spillover://<stepId>/<callId>.json`.
 *
 * Invariants:
 *   - Nothing is written to disk. The results of an execution are held by that
 *     execution only (`createStepSpillover` returns one store per execution),
 *     and `release` drops them when the execution ends, however it ends. A
 *     process that dies loses them with the process.
 *   - A step whose results all stay under the threshold is unchanged.
 *   - The read tool only accepts refs of the same step, finds only results of
 *     the same execution, and reads at most the threshold.
 *   - The budget caps the result bytes the store holds for one execution; a
 *     result that does not fit stays inline, as without spillover, and later
 *     results that fit are still stored.
 *   - Logs carry tool names, sizes and refs only, never result content or
 *     arguments.
 *
 * Configuration is deliberately separate from the first-party agent's
 * `CLERUM_TOOL_SPILLOVER_*` settings: threshold and retention differ.
 */
import { createHash } from 'crypto'
import { Counter } from 'prom-client'
import {
  buildSpilloverRef,
  generateStructureHint,
  inferContentType,
  parseSpilloverRef,
} from '../core/spillover'
import type { SpilloverBlob, SpilloverSummary } from '../core/spillover/types'
import { SpilloverReadTool } from '../core/tools/spilloverRead'
import { logger } from '../logger'
import type { InternalToolDefinition, InternalToolResult } from './types'

export const STEP_SPILLOVER_READ_TOOL_NAME = 'clerum__spillover_read'

const LOG_COMPONENT = 'WorkflowStepSpillover'
const ENABLED_ENV = 'CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED'
const THRESHOLD_ENV = 'CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD'
const BUDGET_ENV = 'CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES'

export const DEFAULT_STEP_SPILLOVER_THRESHOLD_BYTES = 32768
const MIN_THRESHOLD_BYTES = 4096
const MAX_THRESHOLD_BYTES = 1048576
export const DEFAULT_STEP_SPILLOVER_BUDGET_BYTES = 16777216
const MIN_BUDGET_BYTES = 1048576
const MAX_BUDGET_BYTES = 268435456

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/

// Workflow steps report to their own counters, so the first-party agent's
// spillover metrics keep describing the agent only. Guarded like the
// first-party instruments: a duplicate registration (vitest module reuse)
// leaves the export undefined instead of failing module evaluation.
export const clerumWorkflowStepSpilloverPersistedTotal = (() => {
  try {
    return new Counter({
      name: 'clerum_workflow_step_spillover_persisted_total',
      help: 'Count of workflow step tool results stored outside the prompt.',
      labelNames: ['tool'] as const,
    })
  } catch {
    return undefined
  }
})()

export const clerumWorkflowStepSpilloverReadsTotal = (() => {
  try {
    return new Counter({
      name: 'clerum_workflow_step_spillover_reads_total',
      help: 'Count of clerum__spillover_read calls made by workflow steps.',
      labelNames: ['with_range'] as const,
    })
  } catch {
    return undefined
  }
})()

export interface StepSpilloverConfig {
  enabled: boolean
  thresholdBytes: number
  budgetBytes: number
}

function resolveEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  if (value === '' || value === 'true') return true
  if (value === 'false') return false
  logger.warn(
    { component: LOG_COMPONENT, envVar: ENABLED_ENV, value: raw.slice(0, 64), fallback: true },
    `Ignoring invalid ${ENABLED_ENV} (only "false" disables it); spillover stays enabled`
  )
  return true
}

function resolveBytes(
  envVar: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    logger.warn(
      { component: LOG_COMPONENT, envVar, value: raw.slice(0, 64), min, max, fallback },
      `Ignoring invalid ${envVar} (must be an integer within bounds); using fallback`
    )
    return fallback
  }
  return n
}

/** Pure: reads the three variables from `env` (default `process.env`). */
export function resolveStepSpilloverConfig(
  env: NodeJS.ProcessEnv = process.env
): StepSpilloverConfig {
  return {
    enabled: resolveEnabled(env[ENABLED_ENV]),
    thresholdBytes: resolveBytes(
      THRESHOLD_ENV,
      env[THRESHOLD_ENV],
      DEFAULT_STEP_SPILLOVER_THRESHOLD_BYTES,
      MIN_THRESHOLD_BYTES,
      MAX_THRESHOLD_BYTES
    ),
    budgetBytes: resolveBytes(
      BUDGET_ENV,
      env[BUDGET_ENV],
      DEFAULT_STEP_SPILLOVER_BUDGET_BYTES,
      MIN_BUDGET_BYTES,
      MAX_BUDGET_BYTES
    ),
  }
}

export interface StepSpilloverResult {
  /** Text to place in the prompt. */
  text: string
  /** True when `text` is a summary and the original was persisted. */
  spilled: boolean
}

export interface StepSpillover {
  /** Internal tool that reads a spilled result of this step. */
  readTool: InternalToolDefinition
  /** Never throws. When nothing is stored, `text` is `content` unchanged. */
  persist(args: {
    callId: string
    toolName: string
    content: string
    isError: boolean
  }): Promise<StepSpilloverResult>
  /** Drops every stored result. After it the read tool finds nothing. */
  release(): void
}

// Same summary shape as the first-party store (core/spillover/storage.ts).
const HEAD_TAIL_CHARS = 400

function countLines(content: string): number {
  if (content.length === 0) return 0
  let count = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count += 1
  }
  if (content.charCodeAt(content.length - 1) === 10) count -= 1
  return Math.max(count, 1)
}

function readError(error: string): InternalToolResult {
  return { success: false, error }
}

function tooLargeReadError(size: number, thresholdBytes: number): string {
  return `blob is ${size} bytes; pass range {start,end} with end-start <= ${thresholdBytes}`
}

/** Synchronous. Returns null when `stepId` is not a valid ref segment. */
export function createStepSpillover(opts: {
  stepId: string
  thresholdBytes: number
  budgetBytes: number
}): StepSpillover | null {
  const { stepId, thresholdBytes, budgetBytes } = opts
  if (typeof stepId !== 'string' || !SEGMENT_RE.test(stepId)) {
    logger.warn(
      { component: LOG_COMPONENT, stepIdLength: typeof stepId === 'string' ? stepId.length : 0 },
      'Step id is not a valid spillover segment; tool results stay inline for this step'
    )
    return null
  }

  // The spilled results of this execution, by ref. `release` empties the map,
  // after which the read tool finds nothing.
  const blobs = new Map<string, SpilloverBlob>()
  const reader = new SpilloverReadTool(
    { load: (ref: string) => Promise.resolve(blobs.get(ref) ?? null) },
    { reads: clerumWorkflowStepSpilloverReadsTotal }
  )

  let persistedBytes = 0
  let budgetWarned = false

  const readTool: InternalToolDefinition = {
    name: STEP_SPILLOVER_READ_TOOL_NAME,
    description: `${reader.description()} Reads are limited to ${thresholdBytes} bytes; pass range for larger results.`,
    parameters: reader.parametersSchema(),
    async execute(args: Record<string, unknown>): Promise<InternalToolResult> {
      const parsed = parseSpilloverRef(args.ref)
      if (!parsed || parsed.taskId !== stepId) {
        return readError('spillover ref is not available to this step')
      }
      const blob = blobs.get(args.ref as string)
      if (!blob) return readError('spillover blob not found')

      const range =
        args.range && typeof args.range === 'object'
          ? (args.range as { start?: unknown; end?: unknown })
          : null
      if (range === null) {
        if (blob.byte_size > thresholdBytes) {
          return readError(tooLargeReadError(blob.byte_size, thresholdBytes))
        }
      } else if (
        typeof range.start === 'number' &&
        typeof range.end === 'number' &&
        range.end - range.start > thresholdBytes
      ) {
        return readError(tooLargeReadError(blob.byte_size, thresholdBytes))
      }

      const output = await reader.execute(args)
      if (output.is_error) return readError(output.content)
      return { success: true, content: output.content }
    },
  }

  function persist(args: {
    callId: string
    toolName: string
    content: string
    isError: boolean
  }): Promise<StepSpilloverResult> {
    const inline: StepSpilloverResult = { text: args.content, spilled: false }
    if (args.isError || args.toolName === STEP_SPILLOVER_READ_TOOL_NAME) {
      return Promise.resolve(inline)
    }
    if (typeof args.content !== 'string') return Promise.resolve(inline)
    const size = Buffer.byteLength(args.content, 'utf8')
    if (size < thresholdBytes) return Promise.resolve(inline)
    if (persistedBytes + size > budgetBytes) {
      if (!budgetWarned) {
        budgetWarned = true
        logger.warn(
          { component: LOG_COMPONENT, stepId, budgetBytes },
          'Tool result does not fit in the step spillover budget; it stays inline (logged once per step)'
        )
      }
      return Promise.resolve(inline)
    }
    if (!SEGMENT_RE.test(args.callId)) {
      logger.warn(
        { component: LOG_COMPONENT, stepId, toolName: args.toolName, byteSize: size },
        'Call id is not a valid spillover segment; the tool result stays inline'
      )
      return Promise.resolve(inline)
    }

    const contentType = inferContentType(args.toolName, args.content)
    const summary: SpilloverSummary = {
      spillover_ref: buildSpilloverRef(stepId, args.callId),
      byte_size: size,
      line_count: countLines(args.content),
      content_type: contentType,
      fingerprint_sha256: createHash('sha256').update(args.content, 'utf8').digest('hex'),
      head:
        args.content.length > HEAD_TAIL_CHARS
          ? args.content.slice(0, HEAD_TAIL_CHARS)
          : args.content,
      tail: args.content.length > HEAD_TAIL_CHARS ? args.content.slice(-HEAD_TAIL_CHARS) : '',
      structure_hint: generateStructureHint(args.toolName, args.content, contentType),
    }
    blobs.set(summary.spillover_ref, {
      version: 1,
      tool_call_id: args.callId,
      tool_name: args.toolName,
      task_id: stepId,
      created_at_ms: Date.now(),
      byte_size: size,
      line_count: summary.line_count,
      content_type: contentType,
      fingerprint_sha256: summary.fingerprint_sha256,
      content: args.content,
    })
    persistedBytes += size
    clerumWorkflowStepSpilloverPersistedTotal?.inc({ tool: args.toolName })
    logger.info(
      {
        component: LOG_COMPONENT,
        stepId,
        toolName: args.toolName,
        byteSize: size,
        spilloverRef: summary.spillover_ref,
      },
      'Tool result stored outside the prompt'
    )
    return Promise.resolve({
      text:
        `[Result stored outside the prompt (${summary.byte_size} bytes). Read more with ` +
        `${STEP_SPILLOVER_READ_TOOL_NAME}: pass this spillover_ref and a byte range of at most ` +
        `${thresholdBytes} bytes.]\n${JSON.stringify(summary)}`,
      spilled: true,
    })
  }

  function release(): void {
    blobs.clear()
  }

  return { readTool, persist, release }
}

/** What `toolsCalled` records for a read call: never the blob content. */
export function summarizeSpilloverReadForRecord(
  args: Record<string, unknown>,
  result: InternalToolResult
): { success: boolean; ref?: string; bytes?: number; error?: string } {
  const ref = typeof args.ref === 'string' ? args.ref : undefined
  if (!result?.success) {
    return { success: false, ref, error: result?.error }
  }
  return { success: true, ref, bytes: Buffer.byteLength(result.content ?? '', 'utf8') }
}
