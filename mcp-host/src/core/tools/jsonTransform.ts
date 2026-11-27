import { constants as fsConstants } from 'fs'
import * as fs from 'fs/promises'
import { logger } from '../../logger'
import {
  isProtectedWorkspacePath,
  protectedWorkspacePathMessage,
} from '../../workspace/protectedPaths'
import type { FileReads, Tool } from '../interfaces'
import type { ToolOutput, ValidationResult } from '../types'
import { validatePath } from './pathValidation'

const OPERATIONS = ['parse', 'get', 'keys', 'values', 'length', 'stringify'] as const
type Operation = (typeof OPERATIONS)[number]

/** A JSON file larger than this is refused before it is read. */
export const JSON_TRANSFORM_MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * The largest indented result returned, in UTF-8 bytes: `file_read`'s own read
 * limit. Indentation grows with depth, so a 5 MiB file could otherwise become a
 * result of hundreds of MiB, built synchronously.
 */
export const JSON_TRANSFORM_MAX_RESULT_BYTES = 10 * 1024 * 1024

/**
 * The deepest result indented. Parsing is iterative, but `JSON.stringify`
 * recurses, so a deeper value would end in a stack overflow.
 */
export const JSON_TRANSFORM_MAX_RESULT_DEPTH = 256

const RESULT_TOO_LARGE = 'the result is larger than 10 MiB.'
const RESULT_TOO_DEEP = 'the result is nested more than 256 levels deep.'

const ONE_OF_INPUT_AND_FILE = 'Provide exactly one of input and file.'

class TransformError extends Error {}

/**
 * Parse, query and transform JSON from a string or a workspace file.
 *
 * `file` reads the file with `file_read`'s confinement, so `approvalAlso` and
 * `fileReads` make `file_read`'s CRD override and guardrail rules apply to it.
 * Every result is sanitized: file content is untrusted, and the model's own
 * input is treated the same way.
 */
export class JsonTransformTool implements Tool {
  /** `fileToolsRoot`: the root `file_read` uses. Without it, `file` is refused. */
  constructor(private readonly fileToolsRoot?: string) {}

  name() {
    return 'json_transform'
  }
  description() {
    return (
      'Parse, query and transform JSON from a string (input) or a workspace JSON file (file). ' +
      'get returns the value at a dot path; keys, values and length apply to that value ' +
      '(the root when path is empty).'
    )
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'JSON string to process. Exactly one of input and file.',
        },
        file: {
          type: 'string',
          description:
            'Workspace-relative JSON file (at most 5 MiB). Exactly one of input and file.',
        },
        operation: {
          type: 'string',
          enum: [...OPERATIONS],
          description: 'Operation to perform',
        },
        path: {
          type: 'string',
          description: "Dot-separated path into the JSON value (e.g., 'data.items.0.name')",
        },
      },
      required: ['operation'],
    }
  }
  requiresSanitization() {
    return true
  }
  requiresApproval() {
    return false
  }
  approvalAlso(params: Record<string, unknown>): readonly string[] {
    return typeof params.file === 'string' ? ['file_read'] : []
  }
  fileReads(params: Record<string, unknown>): FileReads | undefined {
    return typeof params.file === 'string' ? { paths: [params.file] } : undefined
  }

  validateParams(params: Record<string, unknown>): ValidationResult {
    const errors: string[] = []
    // An explicit null is an absent field, as the previous tool treated it.
    const hasInput = params.input !== undefined && params.input !== null
    const hasFile = params.file !== undefined && params.file !== null
    if (
      hasInput === hasFile ||
      (hasInput && typeof params.input !== 'string') ||
      (hasFile && typeof params.file !== 'string')
    ) {
      errors.push(ONE_OF_INPUT_AND_FILE)
    }
    if (!OPERATIONS.includes(params.operation as Operation)) {
      errors.push(`operation must be one of ${OPERATIONS.join(', ')}.`)
    }
    if (params.path !== undefined && params.path !== null && typeof params.path !== 'string') {
      errors.push('path must be a string.')
    }
    return { is_valid: errors.length === 0, errors }
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const done = (content: string, isError: boolean): ToolOutput => ({
      content,
      duration_ms: Date.now() - startTime,
      is_error: isError,
    })

    const validation = this.validateParams(params)
    if (!validation.is_valid) return done(validation.errors.join(' '), true)
    const operation = params.operation as Operation
    const dotPath = typeof params.path === 'string' && params.path !== '' ? params.path : undefined

    let parsed: unknown
    if (typeof params.file === 'string') {
      const loaded = await this.readJsonFile(params.file)
      if (!loaded.ok) return done(loaded.error, true)
      parsed = loaded.value
    } else {
      try {
        parsed = JSON.parse(params.input as string)
      } catch (err) {
        // The message quotes only the model's own input.
        return done(`Error parsing JSON: ${(err as Error).message}`, true)
      }
    }

    try {
      const result =
        dotPath === undefined
          ? applyAtRoot(operation, parsed)
          : applyAtPath(operation, getByPath(parsed, dotPath), dotPath)
      return done(typeof result === 'string' ? result : indentedJson(result), false)
    } catch (err) {
      return done(`Transform error: ${(err as Error).message}`, true)
    }
  }

  private async readJsonFile(
    file: string
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const root = this.fileToolsRoot
    if (root === undefined)
      return { ok: false, error: 'Error: file input is not available on this Host.' }
    if (isProtectedWorkspacePath(file)) {
      return { ok: false, error: protectedWorkspacePathMessage(file) }
    }
    let resolved: string
    try {
      const validation = validatePath(file, root)
      if (!validation.valid) return { ok: false, error: `Error: ${validation.error}` }
      resolved = validation.resolved
    } catch (err) {
      logger.warn(
        { tool: 'json_transform', code: (err as NodeJS.ErrnoException).code },
        'json_transform could not resolve the file tools root'
      )
      return { ok: false, error: 'Error: the file could not be read.' }
    }

    let text: string
    try {
      // O_NONBLOCK: opening a FIFO returns at once (and is refused as not a
      // file) instead of waiting for a writer.
      const handle = await fs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) return { ok: false, error: 'Error: not a file' }
        if (stat.size > JSON_TRANSFORM_MAX_FILE_BYTES) {
          return { ok: false, error: 'Error: the file is larger than 5 MiB.' }
        }
        // Read at most one byte past the cap, so a file that grew after the
        // size check is refused rather than read whole.
        const buffer = Buffer.alloc(JSON_TRANSFORM_MAX_FILE_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
          if (bytesRead === 0) break
          length += bytesRead
        }
        if (length > JSON_TRANSFORM_MAX_FILE_BYTES) {
          return { ok: false, error: 'Error: the file is larger than 5 MiB.' }
        }
        text = buffer.subarray(0, length).toString('utf-8')
      } finally {
        await handle.close()
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { ok: false, error: 'Error: file not found.' }
      if (code === 'EISDIR') return { ok: false, error: 'Error: not a file' }
      // Node's message names the resolved host path, so the model gets fixed text.
      logger.warn({ tool: 'json_transform', code }, 'json_transform file read failed')
      return { ok: false, error: 'Error: the file could not be read.' }
    }

    try {
      return { ok: true, value: JSON.parse(text) }
    } catch {
      // The parser message can quote file bytes; only the fixed text reaches the model.
      return { ok: false, error: 'Error: the file is not valid JSON.' }
    }
  }
}

/**
 * Without a path: the operations as they were before `path` applied to all of
 * them, except that an indented result over the size or depth bound is refused.
 */
function applyAtRoot(operation: Operation, parsed: any): unknown {
  switch (operation) {
    case 'parse':
    case 'get':
      return parsed
    case 'keys':
      return Object.keys(parsed)
    case 'values':
      return Object.values(parsed)
    case 'length':
      return Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length
    case 'stringify':
      return indentedJson(parsed)
  }
}

/** With a path: every operation works on the value at that path. */
function applyAtPath(operation: Operation, target: unknown, dotPath: string): unknown {
  switch (operation) {
    case 'parse':
    case 'get':
      return target === undefined ? null : target
    case 'stringify':
      return indentedJson(target === undefined ? null : target)
    case 'keys':
    case 'values':
    case 'length': {
      if (target === undefined) throw new TransformError(`no value at path ${dotPath}`)
      if (operation === 'length' && Array.isArray(target)) return target.length
      if (target === null || typeof target !== 'object') {
        throw new TransformError(`${operation} needs an object or array at path`)
      }
      if (operation === 'keys') return Object.keys(target)
      if (operation === 'values') return Object.values(target)
      return Object.keys(target).length
    }
  }
}

/** Own properties only, so a path never reaches a prototype member. */
function getByPath(value: unknown, dotPath: string): unknown {
  let current: unknown = value
  for (const key of dotPath.split('.')) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'string')) {
      return undefined
    }
    if (!Object.hasOwn(current as object, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * `JSON.stringify(value, null, 2)` when the indented text fits in
 * JSON_TRANSFORM_MAX_RESULT_BYTES and JSON_TRANSFORM_MAX_RESULT_DEPTH.
 * The indentation is measured before any text is built, and the walk stops as
 * soon as it passes the bound, so an oversized result costs no more than the
 * bound to refuse.
 */
function indentedJson(value: unknown): string {
  const whitespace = indentationBytes(value, 0, JSON_TRANSFORM_MAX_RESULT_BYTES)
  const compact = JSON.stringify(value) ?? ''
  if (whitespace + Buffer.byteLength(compact) > JSON_TRANSFORM_MAX_RESULT_BYTES) {
    throw new TransformError(RESULT_TOO_LARGE)
  }
  return JSON.stringify(value, null, 2)
}

/**
 * The bytes `JSON.stringify(value, null, 2)` adds to `JSON.stringify(value)`.
 * A non-empty container at depth d adds, per element, a newline and an indent
 * of 2(d+1) spaces (and, in an object, a space after the colon), and before its
 * closing bracket a newline and an indent of 2d spaces. Values come from
 * `JSON.parse`, so every member is serialized and none is skipped.
 */
function indentationBytes(value: unknown, depth: number, budget: number): number {
  if (value === null || typeof value !== 'object') return 0
  if (depth >= JSON_TRANSFORM_MAX_RESULT_DEPTH) throw new TransformError(RESULT_TOO_DEEP)
  const isArray = Array.isArray(value)
  const children: unknown[] = isArray ? (value as unknown[]) : Object.values(value)
  if (children.length === 0) return 0
  const perChild = 1 + 2 * (depth + 1) + (isArray ? 0 : 1)
  let total = children.length * perChild + 1 + 2 * depth
  if (total > budget) throw new TransformError(RESULT_TOO_LARGE)
  for (const child of children) {
    total += indentationBytes(child, depth + 1, budget - total)
    if (total > budget) throw new TransformError(RESULT_TOO_LARGE)
  }
  return total
}
