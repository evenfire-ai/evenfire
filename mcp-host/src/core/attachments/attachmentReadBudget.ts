export const MAX_ATTACHMENT_READS_PER_TURN = 32

export function attachmentReadBudgets(windowTokens: number): {
  pageTokens: number
  turnTokens: number
} {
  if (!Number.isSafeInteger(windowTokens) || windowTokens <= 0) {
    throw new Error('attachmentReadContextWindowTokens must be a positive safe integer')
  }
  return { pageTokens: Math.floor(windowTokens * 0.1), turnTokens: Math.floor(windowTokens * 0.3) }
}

export interface AttachmentReadLedgerSnapshot {
  reads: number
  spentTokens: number
  bytesRead: number
}

function boundedCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Strict reader for a persisted ledger snapshot. Returns null (never a guess,
 * never a partial value) unless every field is a safe non-negative integer and
 * the read count is within the hard cap. The spend is deliberately NOT clamped
 * to a window: a ledger that spent above the current envelope must stay
 * above it, so widening the window later cannot restore spent allowance.
 */
export function readAttachmentReadLedgerSnapshot(
  value: unknown
): AttachmentReadLedgerSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const { reads, spentTokens, bytesRead } = record
  if (!boundedCount(reads as number) || !boundedCount(spentTokens as number)) return null
  if (!boundedCount(bytesRead as number)) return null
  if ((reads as number) > MAX_ATTACHMENT_READS_PER_TURN) return null
  return {
    reads: reads as number,
    spentTokens: spentTokens as number,
    bytesRead: bytesRead as number,
  }
}

/**
 * Monotone per-field maximum. The warm resume path merges the persisted
 * snapshot into the live ledger with this, so a stale or replayed approval can
 * never decrease reads or spend the running turn already recorded.
 */
export function mergeAttachmentReadLedgerSnapshots(
  live: AttachmentReadLedgerSnapshot,
  persisted: AttachmentReadLedgerSnapshot
): AttachmentReadLedgerSnapshot {
  return {
    reads: Math.max(live.reads, persisted.reads),
    spentTokens: Math.max(live.spentTokens, persisted.spentTokens),
    bytesRead: Math.max(live.bytesRead, persisted.bytesRead),
  }
}

/** Owned by one turn; registry memoization does not determine its lifetime. */
export class AttachmentReadLedger {
  private state: AttachmentReadLedgerSnapshot = { reads: 0, spentTokens: 0, bytesRead: 0 }

  snapshot(): AttachmentReadLedgerSnapshot {
    return { ...this.state }
  }

  reset(): void {
    this.state = { reads: 0, spentTokens: 0, bytesRead: 0 }
  }

  restore(snapshot: AttachmentReadLedgerSnapshot): void {
    const parsed = readAttachmentReadLedgerSnapshot(snapshot)
    if (!parsed) throw new Error('Invalid attachment read ledger snapshot')
    this.state = parsed
  }

  /**
   * Fail-closed state for a turn whose spend cannot be trusted (a legacy or
   * corrupt snapshot). No further page can
   * be emitted, and no spend is guessed.
   */
  exhaust(windowTokens: number): void {
    const { turnTokens } = attachmentReadBudgets(windowTokens)
    this.state = {
      reads: MAX_ATTACHMENT_READS_PER_TURN,
      spentTokens: Math.max(this.state.spentTokens, turnTokens),
      bytesRead: this.state.bytesRead,
    }
  }

  beginRead(): boolean {
    if (this.state.reads >= MAX_ATTACHMENT_READS_PER_TURN) return false
    this.state.reads += 1
    return true
  }

  pageAllowance(windowTokens: number, noticeCost: number): number {
    if (!boundedCount(noticeCost) || noticeCost === 0) {
      throw new Error('Invalid attachment notice cost')
    }
    const limits = attachmentReadBudgets(windowTokens)
    // Leave one notice for every remaining call and the first exhausted call,
    // but never more than half of the turn: on a small window 33 notices would
    // exceed the whole turn and no page could ever be emitted. Once the
    // reserved notices are spent, the finalize fence stops the turn.
    const affordableNotices = Math.floor(Math.floor(limits.turnTokens / 2) / noticeCost)
    if (affordableNotices < 1) {
      throw new Error(
        `Attachment read context window of ${windowTokens} tokens is too small to reserve a ${noticeCost}-token budget notice`
      )
    }
    const reserve =
      Math.min(MAX_ATTACHMENT_READS_PER_TURN - this.state.reads + 1, affordableNotices) * noticeCost
    return Math.max(
      0,
      Math.min(limits.pageTokens, limits.turnTokens - this.state.spentTokens - reserve)
    )
  }

  canEmit(windowTokens: number, cost: number): boolean {
    if (!boundedCount(cost)) return false
    const limits = attachmentReadBudgets(windowTokens)
    return cost <= limits.pageTokens && cost <= limits.turnTokens - this.state.spentTokens
  }

  debit(windowTokens: number, cost: number, bytesRead: number): void {
    if (
      !boundedCount(bytesRead) ||
      !this.canEmit(windowTokens, cost) ||
      !Number.isSafeInteger(this.state.spentTokens + cost) ||
      !Number.isSafeInteger(this.state.bytesRead + bytesRead)
    ) {
      throw new Error('Attachment output cannot fit the remaining page/turn budget')
    }
    this.state.spentTokens += cost
    this.state.bytesRead += bytesRead
  }

  /**
   * Charges a trusted exhausted notice that no longer fits the turn. Notices
   * read no bytes and do not count as reads, so a model that keeps calling
   * after the budget binds gets an answer instead of a failed task. The
   * overdraft stops at half a turn above the turn budget; past it the caller
   * stops the turn.
   */
  debitNotice(windowTokens: number, cost: number): void {
    const limits = attachmentReadBudgets(windowTokens)
    const ceiling = limits.turnTokens + Math.floor(limits.turnTokens / 2)
    if (
      !boundedCount(cost) ||
      cost > limits.pageTokens ||
      !Number.isSafeInteger(this.state.spentTokens + cost) ||
      this.state.spentTokens + cost > ceiling
    ) {
      throw new Error('Attachment read notice cannot fit the remaining page/turn budget')
    }
    this.state.spentTokens += cost
  }
}
