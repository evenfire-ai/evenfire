import type { SandboxUiDeepLinkEnvelope, SandboxUiDeepLinkTarget } from './sandboxUiDeepLinks.js'
import { sandboxUiDeepLinkTargetsEqual } from './sandboxUiDeepLinks.js'

export class SandboxUiDeepLinkQueue {
  private readonly pending: SandboxUiQueuedDeepLinkEnvelope[] = []
  private sequence = 0

  constructor(private readonly maxSize = 20) {}

  list(): SandboxUiQueuedDeepLinkEnvelope[] {
    return [...this.pending]
  }

  enqueue(
    target: SandboxUiDeepLinkTarget,
    userNavigationGenerationAtActivation = 0
  ): SandboxUiQueuedDeepLinkEnvelope {
    if (
      !Number.isSafeInteger(userNavigationGenerationAtActivation) ||
      userNavigationGenerationAtActivation < 0
    ) {
      throw new Error('Invalid App deep-link navigation generation')
    }
    const existingIndex = this.pending.findIndex(item =>
      sandboxUiDeepLinkTargetsEqual(item, target)
    )
    if (existingIndex >= 0) {
      return this.pending[existingIndex]!
    }
    const envelope = {
      id: (this.sequence += 1),
      ...target,
      userNavigationGenerationAtActivation,
    }
    this.pending.push(envelope)
    if (this.pending.length > this.maxSize) this.pending.shift()
    return envelope
  }

  acknowledge(id: number): void {
    const index = this.pending.findIndex(item => item.id === id)
    if (index >= 0) this.pending.splice(index, 1)
  }

  clear(): number {
    this.pending.splice(0)
    return this.sequence + 1
  }
}

export type SandboxUiQueuedDeepLinkEnvelope = SandboxUiDeepLinkEnvelope & {
  userNavigationGenerationAtActivation: number
}
