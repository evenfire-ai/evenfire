/**
 * T1.5 — Filesystem-backed `SpilloverResolver` implementation.
 *
 * Implements the P.3 contract (`SpilloverResolver`): on resume, swap in the
 * blob body for entries that carry a `spillover_ref`. If the blob is gone
 * (TTL expired / GC'd), throw `ApprovalExpiredError` — we NEVER silently
 * regenerate the originating tool call (audit invariant).
 *
 * The resolver is stateless beyond the underlying `SpilloverStorage`; it can
 * be shared across executors and lives for the Pod lifetime.
 */
import type { SpilloverResolver } from '../orchestration/spilloverResolver'
import type { ChatMessage, ToolResult } from '../types'
import { ApprovalExpiredError } from '../types'
import { SpilloverStorage, clerumApprovalExpiredTotal } from './storage'

export interface FsSpilloverResolverDeps {
  storage: SpilloverStorage
}

/**
 * Optional context the caller can attach so `ApprovalExpiredError` carries
 * accurate `task_id`/`request_id`/`tool_name` in its payload. Passed via the
 * `resolveCompletedResults` helper (`resolveCompletedResults` lives on the
 * task executor — see `taskExecutor.ts`).
 */
export interface ResolveContext {
  taskId: string
  requestId: string
  toolName: string
}

const NULL_CONTEXT: ResolveContext = { taskId: '', requestId: '', toolName: '' }

export class FsSpilloverResolver implements SpilloverResolver {
  private readonly storage: SpilloverStorage
  private readonly contextStack: ResolveContext[] = []

  constructor(deps: FsSpilloverResolverDeps) {
    this.storage = deps.storage
  }

  /**
   * Run `fn` with `ctx` attached so any `ApprovalExpiredError` thrown by a
   * downstream `resolve()` carries the correct payload. Synchronous push/pop
   * — async re-entrance with different contexts isn't supported because the
   * resume path is sequential per executor.
   */
  async withContext<T>(ctx: ResolveContext, fn: () => Promise<T>): Promise<T> {
    this.contextStack.push(ctx)
    try {
      return await fn()
    } finally {
      this.contextStack.pop()
    }
  }

  async resolve(m: Pick<ChatMessage | ToolResult, 'content' | 'spillover_ref'>): Promise<string> {
    if (!m.spillover_ref) return m.content
    const blob = await this.storage.load(m.spillover_ref)
    if (blob) return blob.content
    const ctx = this.contextStack[this.contextStack.length - 1] ?? NULL_CONTEXT
    clerumApprovalExpiredTotal?.inc({ reason: 'spillover_missing' })
    throw new ApprovalExpiredError({
      code: 'approval_expired',
      request_id: ctx.requestId,
      task_id: ctx.taskId,
      tool_name: ctx.toolName,
      expired_refs: [m.spillover_ref],
      user_message:
        'The data your approval referenced has expired. Please re-issue the original command.',
    })
  }

  async probe(refs: string[]): Promise<{ alive: string[]; expired: string[] }> {
    const alive: string[] = []
    const expired: string[] = []
    for (const ref of refs) {
      if (await this.storage.exists(ref)) alive.push(ref)
      else expired.push(ref)
    }
    return { alive, expired }
  }
}
