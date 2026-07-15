import * as fs from 'fs/promises'
import { isStateDbPath, stateDbProtectedMessage } from '../../workspace/service'
import { Tool } from '../interfaces'
import { ToolOutput } from '../types'
import { validatePath } from './pathValidation'

const MAX_READ_SIZE = 10 * 1024 * 1024 // 10MB

export class FileReadTool implements Tool {
  constructor(private readonly workspacePath: string) {}

  name() {
    return 'file_read'
  }
  description() {
    return (
      'Read the contents of a file within the workspace directory. ' +
      'Provide the relative path from the workspace root.'
    )
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file (from workspace root)',
        },
        encoding: {
          type: 'string',
          description: 'File encoding (default: utf-8)',
          enum: ['utf-8', 'ascii', 'base64'],
        },
      },
      required: ['path'],
    }
  }
  requiresSanitization() {
    return true
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const filePath = params.path as string
    const encoding = (params.encoding as BufferEncoding) || 'utf-8'

    // D3 — the session state database holds every user's conversations; the
    // agent must not read it (or its WAL laterals) through file tools.
    if (isStateDbPath(filePath)) {
      return {
        content: stateDbProtectedMessage(filePath),
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    const validation = validatePath(filePath, this.workspacePath)
    if (!validation.valid) {
      return {
        content: `Error: ${validation.error}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    // Check file size before reading
    try {
      const stat = await fs.stat(validation.resolved)
      if (stat.size > MAX_READ_SIZE) {
        return {
          content: `Error: File too large (${stat.size} bytes, max ${MAX_READ_SIZE} bytes)`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        }
      }
    } catch {
      // File may not exist — let the read fail naturally with a descriptive error
    }

    try {
      const content = await fs.readFile(validation.resolved, { encoding })
      return {
        content,
        duration_ms: Date.now() - startTime,
        is_error: false,
      }
    } catch (err) {
      return {
        content: `Error reading file: ${(err as Error).message}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }
  }
}
