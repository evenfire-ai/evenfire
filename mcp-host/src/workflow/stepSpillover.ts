/**
 * Tool-result spillover for agentic workflow steps.
 *
 * `WorkflowService.executeStep` pastes every tool result into the prompt and
 * resends it on each iteration. This module wires the shared spillover store
 * (`core/spillover`) into that loop: a result at or above the threshold is
 * written under `<outputDir>/.spill/spillover/<stepId>/<callId>.json` and the
 * model receives the store's summary plus a `spillover_ref` it can read back
 * by byte range with `clerum__spillover_read`.
 *
 * Invariants:
 *   - Nothing touches the disk until the first result is persisted, so a step
 *     whose results all stay under the threshold is unchanged.
 *   - The read tool only accepts refs of the same step, and reads of at most
 *     the threshold.
 *   - Logs carry tool names, sizes and refs only, never result content or
 *     arguments.
 *
 * Configuration is deliberately separate from the first-party agent's
 * `CLERUM_TOOL_SPILLOVER_*` settings: threshold and retention differ.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { SpilloverStorage, parseSpilloverRef } from '../core/spillover'
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

const SPILL_DIR = '.spill'
const STORE_ROOT = 'spillover'
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/

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
  /** Internal tool that reads a spilled blob of this step. */
  readTool: InternalToolDefinition
  /** Never throws. When nothing is persisted, `text` is `content` unchanged. */
  persist(args: {
    callId: string
    toolName: string
    content: string
    isError: boolean
  }): Promise<StepSpilloverResult>
  /** Removes this step's blobs. Never throws; no-op when nothing was written. */
  cleanup(): Promise<void>
}

function readError(error: string): InternalToolResult {
  return { success: false, error }
}

function tooLargeReadError(size: number, thresholdBytes: number): string {
  return `blob is ${size} bytes; pass range {start,end} with end-start <= ${thresholdBytes}`
}

/** Synchronous and disk-free. Returns null when `stepId` is not a valid store segment. */
export function createStepSpillover(opts: {
  outputDir: string
  stepId: string
  thresholdBytes: number
  budgetBytes: number
}): StepSpillover | null {
  const { outputDir, stepId, thresholdBytes, budgetBytes } = opts
  if (typeof stepId !== 'string' || !SEGMENT_RE.test(stepId)) {
    logger.warn(
      { component: LOG_COMPONENT, stepIdLength: typeof stepId === 'string' ? stepId.length : 0 },
      'Step id is not a valid spillover segment; tool results stay inline for this step'
    )
    return null
  }

  const spillRoot = path.join(outputDir, SPILL_DIR)
  const storeRoot = path.join(spillRoot, STORE_ROOT)
  const stepDir = path.join(storeRoot, stepId)
  const storage = new SpilloverStorage({
    workspacePath: spillRoot,
    thresholdBytes,
    ttlMs: 0,
    gcIntervalMs: 0,
  })
  const reader = new SpilloverReadTool(storage)

  let persistedBytes = 0
  let attemptedWrite = false
  let writeFailed = false
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
      const blob = await storage.load(args.ref as string)
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

  async function persist(args: {
    callId: string
    toolName: string
    content: string
    isError: boolean
  }): Promise<StepSpilloverResult> {
    const inline: StepSpilloverResult = { text: args.content, spilled: false }
    if (args.isError || args.toolName === STEP_SPILLOVER_READ_TOOL_NAME) return inline
    if (writeFailed || typeof args.content !== 'string') return inline
    const size = Buffer.byteLength(args.content, 'utf8')
    if (size < thresholdBytes) return inline
    if (persistedBytes + size > budgetBytes) {
      if (!budgetWarned) {
        budgetWarned = true
        logger.warn(
          { component: LOG_COMPONENT, stepId, budgetBytes },
          'Step spillover budget exceeded; further tool results stay inline'
        )
      }
      return inline
    }
    try {
      attemptedWrite = true
      const summary = await storage.maybePersist({
        taskId: stepId,
        toolCallId: args.callId,
        toolName: args.toolName,
        content: args.content,
        isError: false,
      })
      if (!summary) return inline
      persistedBytes += size
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
      return {
        text:
          `[Result stored outside the prompt (${summary.byte_size} bytes). Read more with ` +
          `${STEP_SPILLOVER_READ_TOOL_NAME}: pass this spillover_ref and a byte range of at most ` +
          `${thresholdBytes} bytes.]\n${JSON.stringify(summary)}`,
        spilled: true,
      }
    } catch (err) {
      writeFailed = true
      logger.warn(
        {
          component: LOG_COMPONENT,
          stepId,
          toolName: args.toolName,
          byteSize: size,
          errorCode: (err as NodeJS.ErrnoException | undefined)?.code,
        },
        'Could not persist tool result; results stay inline for the rest of this step'
      )
      return inline
    }
  }

  async function cleanup(): Promise<void> {
    if (!attemptedWrite) return
    try {
      await fs.rm(stepDir, { recursive: true, force: true })
    } catch (err) {
      logger.warn(
        {
          component: LOG_COMPONENT,
          stepId,
          errorCode: (err as NodeJS.ErrnoException | undefined)?.code,
        },
        'Could not remove step spillover directory'
      )
      return
    }
    // Remove the parents only when empty; another step may still use them.
    for (const dir of [storeRoot, spillRoot]) {
      try {
        await fs.rmdir(dir)
      } catch {
        return
      }
    }
  }

  return { readTool, persist, cleanup }
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
