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
      return done(typeof result === 'string' ? result : JSON.stringify(result, null, 2), false)
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

/** Without a path: exactly the operations as they were before `path` applied to all of them. */
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
      return JSON.stringify(parsed, null, 2)
  }
}

/** With a path: every operation works on the value at that path. */
function applyAtPath(operation: Operation, target: unknown, dotPath: string): unknown {
  switch (operation) {
    case 'parse':
    case 'get':
      return target === undefined ? null : target
    case 'stringify':
      return JSON.stringify(target === undefined ? null : target, null, 2)
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
