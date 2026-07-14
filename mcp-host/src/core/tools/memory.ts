import type { Workspace } from '../../workspace/service'
import { adminManagedIdentityFileMessage, isLockedPath } from '../../workspace/service'
import { Tool } from '../interfaces'
import { ToolOutput } from '../types'

// ─── Persistent (filesystem-backed) memory tools ────────────────────────────

function nowTime(): string {
  return new Date().toISOString().slice(11, 19) // HH:MM:SS
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

export class MemorySearchTool implements Tool {
  constructor(private readonly workspace: Workspace) {}

  name() {
    return 'memory_search'
  }
  description() {
    return (
      'Search past memories, decisions, and context in the persistent workspace. ' +
      'Call this before answering questions about prior work or decisions.'
    )
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'integer', default: 5, minimum: 1, maximum: 20 },
      },
      required: ['query'],
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const results = await this.workspace.search(
      params.query as string,
      (params.limit as number) || 5
    )
    return {
      content: JSON.stringify({
        query: params.query,
        results: results.map(r => ({
          path: r.path,
          content: r.content,
          score: r.score,
        })),
        result_count: results.length,
      }),
      duration_ms: Date.now() - startTime,
      is_error: false,
    }
  }
}

export class PersistentMemoryWriteTool implements Tool {
  constructor(private readonly workspace: Workspace) {}

  name() {
    return 'memory_write'
  }
  description() {
    return 'Write to persistent workspace memory. Content persists across conversations.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to write' },
        target: {
          type: 'string',
          default: 'daily_log',
          description:
            "Target: 'memory' (collective/team MEMORY.md), 'memory_private' " +
            "(facts about the specific person you're talking to — never shared " +
            "with other users), 'daily_log' (today's log), 'heartbeat' " +
            '(HEARTBEAT.md), or any relative file path',
        },
        append: {
          type: 'boolean',
          default: true,
          description: 'Append (true) or replace (false)',
        },
      },
      required: ['content'],
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  private rejectionOutput(err: unknown, startTime: number): ToolOutput | null {
    if (
      err instanceof Error &&
      (err.name === 'LockedFileError' ||
        err.name === 'MemoryScanRejectionError' ||
        err.name === 'CrossUserAccessError')
    ) {
      return { content: err.message, duration_ms: Date.now() - startTime, is_error: true }
    }
    return null
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const content = params.content as string
    const target = (params.target as string) || 'daily_log'
    const append = params.append !== false

    // Private (per-user) memory (F5): dedicated methods, not a path — 'MEMORY.md'
    // routes to the collective and 'users/...' is denied by the workspace guard.
    if (target === 'memory_private') {
      try {
        if (append) await this.workspace.appendPrivateMemory(content)
        else await this.workspace.writePrivateMemory(content)
      } catch (err) {
        const out = this.rejectionOutput(err, startTime)
        if (out) return out
        throw err
      }
      return {
        content: `Written to private memory (${append ? 'append' : 'replace'})`,
        duration_ms: Date.now() - startTime,
        is_error: false,
      }
    }

    let filePath: string
    switch (target) {
      case 'memory':
        filePath = 'MEMORY.md'
        break
      case 'daily_log':
        filePath = `daily/${todayDate()}.md`
        break
      case 'heartbeat':
        filePath = 'HEARTBEAT.md'
        break
      default:
        filePath = target
        break
    }

    if (isLockedPath(filePath)) {
      return {
        content: adminManagedIdentityFileMessage(filePath),
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    try {
      if (target === 'daily_log' && append) {
        await this.workspace.append(filePath, `[${nowTime()}] ${content}`)
      } else if (append) {
        await this.workspace.append(filePath, content)
      } else {
        await this.workspace.write(filePath, content)
      }
    } catch (err) {
      const out = this.rejectionOutput(err, startTime)
      if (out) return out
      throw err
    }

    return {
      content: `Written to ${filePath} (${append ? 'append' : 'replace'})`,
      duration_ms: Date.now() - startTime,
      is_error: false,
    }
  }
}

export class PersistentMemoryReadTool implements Tool {
  constructor(private readonly workspace: Workspace) {}

  name() {
    return 'memory_read'
  }
  description() {
    return 'Read a file from persistent workspace memory.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "File path to read (e.g. 'MEMORY.md', 'daily/2026-02-25.md')",
        },
        scope: {
          type: 'string',
          enum: ['private'],
          description:
            "Set to 'private' to read your private per-user memory (facts about " +
            'the current person). Omit to read a regular file path.',
        },
      },
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()

    // Private memory (F5): read the per-user MEMORY.md. memory_read by path can't
    // reach it ('MEMORY.md' routes to collective; 'users/...' is denied).
    if (params.scope === 'private') {
      const priv = await this.workspace.readPrivateMemory()
      return {
        content: JSON.stringify({
          scope: 'private',
          content: priv,
          word_count: priv.split(/\s+/).filter(Boolean).length,
        }),
        duration_ms: Date.now() - startTime,
        is_error: false,
      }
    }

    const path = typeof params.path === 'string' ? params.path : ''
    if (!path) {
      return {
        content: "Missing 'path' (or use scope:'private').",
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }
    const content = await this.workspace.read(path)
    if (content === null) {
      return {
        content: `File not found: ${path}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }
    const wordCount = content.split(/\s+/).filter(Boolean).length
    return {
      content: JSON.stringify({ path, content, word_count: wordCount }),
      duration_ms: Date.now() - startTime,
      is_error: false,
    }
  }
}

export class MemoryTreeTool implements Tool {
  constructor(private readonly workspace: Workspace) {}

  name() {
    return 'memory_tree'
  }
  description() {
    return 'View workspace memory structure as a directory tree.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          default: '',
          description: 'Directory to list (empty = root)',
        },
      },
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const entries = await this.workspace.list((params.path as string) || '')
    return {
      content: JSON.stringify(entries),
      duration_ms: Date.now() - startTime,
      is_error: false,
    }
  }
}
