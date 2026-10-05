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
    if (
      !Object.values(snapshot).every(boundedCount) ||
      snapshot.reads > MAX_ATTACHMENT_READS_PER_TURN
    ) {
      throw new Error('Invalid attachment read ledger snapshot')
    }
    this.state = { ...snapshot }
  }

  beginRead(): boolean {
    if (this.state.reads >= MAX_ATTACHMENT_READS_PER_TURN) return false
    this.state.reads += 1
    return true
  }

  pageAllowance(windowTokens: number, noticeCost: number): number {
    if (!boundedCount(noticeCost)) throw new Error('Invalid attachment notice cost')
    const limits = attachmentReadBudgets(windowTokens)
    // Leave one notice for every remaining call and the first exhausted call.
    const reserve = (MAX_ATTACHMENT_READS_PER_TURN - this.state.reads + 1) * noticeCost
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
    if (!boundedCount(bytesRead) || !this.canEmit(windowTokens, cost)) {
      throw new Error('Attachment output cannot fit the remaining page/turn budget')
    }
    this.state.spentTokens += cost
    this.state.bytesRead += bytesRead
  }
}
