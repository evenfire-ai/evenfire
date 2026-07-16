import * as fs from 'fs/promises'
import * as path from 'path'
import {
  adminManagedIdentityFileMessage,
  isLockedPath,
  isStateDbPath,
  stateDbProtectedMessage,
} from '../../workspace/service'
import { Tool } from '../interfaces'
import { ToolOutput } from '../types'
import { validatePath } from './pathValidation'

const MAX_WRITE_SIZE = 5 * 1024 * 1024 // 5MB

export class FileWriteTool implements Tool {
  constructor(private readonly workspacePath: string) {}

  name() {
    return 'file_write'
  }
  description() {
    return (
      'Write content to a file within the workspace directory. ' +
      "Creates the file if it doesn't exist. Creates parent directories if needed."
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
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
        append: {
          type: 'boolean',
          description: 'Append to file instead of overwriting (default: false)',
        },
      },
      required: ['path', 'content'],
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
    const content = params.content as string
    const append = (params.append as boolean) || false

    if (content.length > MAX_WRITE_SIZE) {
      return {
        content: `Error: Content too large (${content.length} bytes, max ${MAX_WRITE_SIZE} bytes)`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    if (isLockedPath(filePath)) {
      return {
        content: adminManagedIdentityFileMessage(filePath),
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    // D3 — the session state database is platform state, never agent-writable.
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

    try {
      // Ensure parent directory exists
      await fs.mkdir(path.dirname(validation.resolved), { recursive: true })

      if (append) {
        await fs.appendFile(validation.resolved, content, 'utf-8')
      } else {
        await fs.writeFile(validation.resolved, content, 'utf-8')
      }

      const stat = await fs.stat(validation.resolved)
      return {
        content: `File written successfully: ${filePath} (${stat.size} bytes)`,
        duration_ms: Date.now() - startTime,
        is_error: false,
      }
    } catch (err) {
      return {
        content: `Error writing file: ${(err as Error).message}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }
  }
}
