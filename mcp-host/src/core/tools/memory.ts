import { memoryNotePath } from '../../workspace/memoryNotePath'
import {
  ProtectedWorkspacePathError,
  isProtectedWorkspacePath,
  protectedWorkspacePathMessage,
} from '../../workspace/protectedPaths'
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

function protectedPathOutput(err: unknown, startTime: number): ToolOutput | null {
  if (err instanceof ProtectedWorkspacePathError) {
    return { content: err.message, duration_ms: Date.now() - startTime, is_error: true }
  }
  return null
}

export class MemorySearchTool implements Tool {
  constructor(private readonly workspace: Workspace) {}

  name() {
    return 'memory_search'
  }
  description() {
    return (
      'Search memory: MEMORY.md (shared and private), the shared memories/ folder, your ' +
      'daily/ log and the notes in your memory/ folder. Call this before answering ' +
      'questions about prior work or decisions. It also returns lines from other .md files ' +
      'of your folder: those are workspace files, not memory, and memory_read does not ' +
      'open them. A result whose path is MEMORY.md may come from your private memory: read ' +
      "it with scope 'private'. Recall memory with this tool and memory_read, not by " +
      'browsing workspace files with file_read or the shell.'
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
    let results
    try {
      results = await this.workspace.search(params.query as string, (params.limit as number) || 5)
    } catch (err) {
      const out = protectedPathOutput(err, startTime)
      if (out) return out
      throw err
    }
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
    return (
      'Save to persistent memory. Everything written here is kept across conversations ' +
      'and is never expired by the Host. Memory is in one place: MEMORY.md (shared and ' +
      'private), the shared memories/ folder, your daily/ log and your memory/ folder; ' +
      'other workspace files are not memory.'
    )
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
            "Where to save. 'memory': the team's shared MEMORY.md, read by everyone who " +
            "talks to this agent. 'memory_private': the private MEMORY.md of the person you " +
            "are talking to, never shared. 'daily_log' (default): today's log of this " +
            "person, daily/<date>.md. 'heartbeat': the shared HEARTBEAT.md. The paths " +
            "'MEMORY.md', 'HEARTBEAT.md', 'memories/<name>.md' and 'daily/<date>.md' are " +
            'written where they are, and the identity files (IDENTITY.md, SOUL.md, ' +
            'AGENTS.md, USER.md) are refused. Any other relative path is a named note of ' +
            'this person, private to them and saved as Markdown in their memory/ folder ' +
            "(for example 'preferences.md' is saved as memory/preferences.md). Knowledge for " +
            'the whole team (conventions, decisions, facts for everyone) goes to the shared ' +
            "memory instead: target 'memory', or a shared note 'memories/<name>.md'. Every " +
            "file this person's memory depends on (a reference document, their rules) " +
            'belongs in memory/: a file elsewhere in the workspace is not memory and may be ' +
            "deleted. Work files of a task (a review's ledger, a checkout, a draft) are not " +
            'memory: keep them in the workspace. Notes are Markdown only: .md is added to a ' +
            "note in memory/ whose path does not already end in .md ('data.json' is saved as " +
            'memory/data.json.md); nothing is added to MEMORY.md, HEARTBEAT.md, memories/ or ' +
            'daily/ paths, so give a shared note under memories/ a name that ends in .md ' +
            '(memory_search reads .md files only). Read a note back with memory_read and the ' +
            'same path.',
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
        err instanceof ProtectedWorkspacePathError ||
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
        // A free path is a named note in the caller's memory/ folder.
        filePath = memoryNotePath(target)
        break
    }

    if (isLockedPath(filePath)) {
      return {
        content: adminManagedIdentityFileMessage(filePath),
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    // Platform-owned state and governed GFS downloads are not memory targets.
    if (isProtectedWorkspacePath(filePath)) {
      return {
        content: protectedWorkspacePathMessage(filePath),
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
    return (
      "Read from persistent memory: MEMORY.md (shared, or private with scope 'private'), " +
      'a shared note in memories/, your daily/ log or a note in your memory/ folder. This ' +
      'is the only way to read memory. It does not read other workspace files, and a ' +
      'workspace file is not memory.'
    )
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Memory path: 'MEMORY.md' (shared), 'memories/<name>.md' (shared note), " +
            "'daily/2026-02-25.md', or a note path as given to memory_write " +
            "('projects/acme.md' or 'memory/projects/acme.md'; .md is added as in " +
            "memory_write). 'MEMORY.md', 'HEARTBEAT.md', the identity files (IDENTITY.md, " +
            "SOUL.md, AGENTS.md, USER.md), 'daily/...' and 'memories/...' are read where " +
            'they are. Any other path is a note: it is looked up in memory/ and answers ' +
            "'File not found' when the note is not there.",
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
    // Resolved like memory_write, so a note is read back with the path it was written with.
    const resolved = memoryNotePath(path)
    let content: string | null
    try {
      content = await this.workspace.read(resolved)
    } catch (err) {
      const out = protectedPathOutput(err, startTime)
      if (out) return out
      throw err
    }
    if (content === null) {
      return {
        content: `File not found: ${resolved}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }
    const wordCount = content.split(/\s+/).filter(Boolean).length
    return {
      content: JSON.stringify({ path: resolved, content, word_count: wordCount }),
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
    return (
      'List your folder and the shared memory as a directory tree. Only MEMORY.md, ' +
      'memories/, daily/ and memory/ are memory; read those with memory_read. The root can ' +
      'list MEMORY.md twice: the shared one, and your private one, which is read with ' +
      "scope 'private'."
    )
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
    let entries
    try {
      entries = await this.workspace.list((params.path as string) || '')
    } catch (err) {
      const out = protectedPathOutput(err, startTime)
      if (out) return out
      throw err
    }
    return {
      content: JSON.stringify(entries),
      duration_ms: Date.now() - startTime,
      is_error: false,
    }
  }
}
