import type { GfsResourceDeepLinkEnvelope, GfsResourceDeepLinkTarget } from './gfsDeepLinks.js'
import { normalizeGfsResourceUri } from './gfsDeepLinks.js'

export class GfsResourceDeepLinkQueue {
  private readonly pending: GfsResourceDeepLinkEnvelope[] = []
  private sequence = 0

  constructor(private readonly maxSize = 20) {}

  list(): GfsResourceDeepLinkEnvelope[] {
    return [...this.pending]
  }

  enqueue(target: GfsResourceDeepLinkTarget): GfsResourceDeepLinkEnvelope {
    const uri = normalizeGfsResourceUri(target.uri)
    if (!uri) throw new Error('Invalid GFS resource deep link')
    const existing = this.pending.find(item => item.uri === uri)
    if (existing) return existing
    const envelope = { id: (this.sequence += 1), uri }
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
