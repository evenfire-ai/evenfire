import type { SandboxUiDeepLinkEnvelope, SandboxUiDeepLinkTarget } from './sandboxUiDeepLinks.js'
import { sandboxUiDeepLinkTargetsEqual } from './sandboxUiDeepLinks.js'

export class SandboxUiDeepLinkQueue {
  private readonly pending: SandboxUiDeepLinkEnvelope[] = []
  private sequence = 0

  constructor(private readonly maxSize = 20) {}

  list(): SandboxUiDeepLinkEnvelope[] {
    return [...this.pending]
  }

  enqueue(target: SandboxUiDeepLinkTarget): SandboxUiDeepLinkEnvelope | null {
    if (this.pending.some(item => sandboxUiDeepLinkTargetsEqual(item, target))) return null
    const envelope = { id: (this.sequence += 1), ...target }
    this.pending.push(envelope)
    if (this.pending.length > this.maxSize) this.pending.shift()
    return envelope
  }

  acknowledge(id: number): void {
    const index = this.pending.findIndex(item => item.id === id)
    if (index >= 0) this.pending.splice(index, 1)
  }

  clear(): void {
    this.pending.splice(0)
  }
}
