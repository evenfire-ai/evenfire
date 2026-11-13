/**
 * Tool-result spillover for agentic workflow steps.
 *
 * `WorkflowService.executeStep` pastes every tool result into the prompt and
 * resends it on each iteration. This module wires the shared spillover store
 * (`core/spillover`) into that loop: a result at or above the threshold is
 * written under `<outputDir>/.spill/<executionId>/spillover/<stepId>/<callId>.json`
 * and the model receives the store's summary plus a `spillover_ref` it can
 * read back by byte range with `clerum__spillover_read`. `executionId` is
 * random per step execution, so refs stay `spillover://<stepId>/<callId>.json`
 * while one execution can never read or delete another's files.
 *
 * Invariants:
 *   - A step execution writes nothing until its first result is persisted, so
 *     a step whose results all stay under the threshold is unchanged. The
 *     first step of a process removes spill files a dead process left
 *     (`removeLeftoverStepSpillover`).
 *   - `.spill` is used only when it is a real directory. When it is a symbolic
 *     link or a file, nothing is listed, written or removed through it:
 *     results stay inline and a warning is logged.
 *   - The read tool only accepts refs of the same step, finds only blobs of
 *     the same execution, and reads at most the threshold.
 *   - The budget caps the result bytes persisted by one execution; a result
 *     that does not fit stays inline and later results that fit still spill.
 *   - Logs carry tool names, sizes and refs only, never result content or
 *     arguments.
 *
 * Configuration is deliberately separate from the first-party agent's
 * `CLERUM_TOOL_SPILLOVER_*` settings: threshold and retention differ.
 */
import { randomBytes } from 'crypto'
import type { Stats } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'
import { Counter } from 'prom-client'
import { SpilloverStorage, parseSpilloverRef } from '../core/spillover'
import type { SpilloverInstruments } from '../core/spillover/types'
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
const EXECUTION_DIR_RE = /^[0-9a-f]{16}$/

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

// No output-size histogram: the step store only sees results at or above the
// threshold, so it could not describe the size distribution.
const STEP_SPILLOVER_INSTRUMENTS: SpilloverInstruments = {
  persisted: clerumWorkflowStepSpilloverPersistedTotal,
  reads: clerumWorkflowStepSpilloverReadsTotal,
}

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
  /**
   * Removes this execution's blobs. Never throws; no-op when nothing was
   * written. Removes nothing when `.spill` is no longer a directory.
   */
  cleanup(): Promise<void>
}

/**
 * True when `spillRootAbs` is a directory, false when it does not exist.
 * Rejects with `ENOTDIR` when it is anything else (a symbolic link, a file),
 * and with the `lstat` error when it cannot be examined. `lstat` does not
 * follow a link in the last path component.
 */
async function spillRootIsDirectory(spillRootAbs: string): Promise<boolean> {
  let stat: Stats
  try {
    stat = await fs.lstat(spillRootAbs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false
    throw err
  }
  if (stat.isDirectory()) return true
  throw Object.assign(new Error('step spillover root is not a directory'), { code: 'ENOTDIR' })
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
  const spillRootAbs = path.resolve(spillRoot)
  const executionId = randomBytes(8).toString('hex')
  const executionRoot = path.join(spillRoot, executionId)
  const storage = new SpilloverStorage({
    workspacePath: executionRoot,
    thresholdBytes,
    ttlMs: 0,
    gcIntervalMs: 0,
    instruments: STEP_SPILLOVER_INSTRUMENTS,
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
          'Tool result does not fit in the step spillover budget; it stays inline (logged once per step)'
        )
      }
      return inline
    }
    try {
      attemptedWrite = true
      // Rejects for a `.spill` that is a link or a file, so nothing is written
      // through it; a missing `.spill` is created by the store.
      await spillRootIsDirectory(spillRootAbs)
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
    // The recursive delete must stay inside `.spill`: the execution id is
    // generated here as hex, and this re-checks the resolved path. That check
    // is lexical; the `lstat` check below keeps a `.spill` that was replaced by
    // a symbolic link from being followed.
    const executionDir = path.resolve(spillRootAbs, executionId)
    if (!executionDir.startsWith(spillRootAbs + path.sep)) return
    try {
      if (!(await spillRootIsDirectory(spillRootAbs))) return
      await fs.rm(executionDir, { recursive: true, force: true })
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
    // Remove `.spill` only when empty; another execution may still use it.
    try {
      await fs.rmdir(spillRoot)
    } catch {
      // Not empty, or already gone.
    }
  }

  return { readTool, persist, cleanup }
}

/**
 * Removes the spill files a process that died mid-step left in `outputDir`:
 * `.spill/<executionId>` directories and the older `.spill/spillover` layout.
 * Other entries under `.spill` are kept. A `.spill` that is not a real
 * directory (a symbolic link, a file) is left alone, with a warning. Creates
 * nothing and never throws.
 *
 * Call it once per process, before the first step creates its store: no
 * execution of this process can own a spill directory yet.
 */
export async function removeLeftoverStepSpillover(outputDir: string): Promise<void> {
  const spillRootAbs = path.resolve(outputDir, SPILL_DIR)
  let entries: string[]
  try {
    if (!(await spillRootIsDirectory(spillRootAbs))) return
    entries = await fs.readdir(spillRootAbs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return
    logger.warn(
      { component: LOG_COMPONENT, errorCode: code },
      'Could not list leftover step spillover files'
    )
    return
  }

  let removed = 0
  for (const entry of entries) {
    if (entry !== STORE_ROOT && !EXECUTION_DIR_RE.test(entry)) continue
    const target = path.resolve(spillRootAbs, entry)
    if (!target.startsWith(spillRootAbs + path.sep)) continue
    try {
      await fs.rm(target, { recursive: true, force: true })
      removed += 1
    } catch (err) {
      logger.warn(
        {
          component: LOG_COMPONENT,
          errorCode: (err as NodeJS.ErrnoException | undefined)?.code,
        },
        'Could not remove leftover step spillover files'
      )
    }
  }
  if (removed > 0) {
    logger.info(
      { component: LOG_COMPONENT, removedEntries: removed },
      'Removed step spillover files left by an earlier process'
    )
  }
  try {
    await fs.rmdir(spillRootAbs)
  } catch {
    // Not empty: other entries under `.spill` are not this feature's.
  }
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
