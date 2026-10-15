import type { GfsResourceDeepLinkEnvelope, GfsResourceDeepLinkTarget } from './gfsDeepLinks.js'
import { normalizeGfsResourceUri } from './gfsDeepLinks.js'

export class GfsUserNavigationGeneration {
  private value = 0

  current(): number {
    return this.value
  }

  advance(): number {
    if (this.value >= Number.MAX_SAFE_INTEGER) {
      throw new Error('GFS user navigation generation is exhausted')
    }
    return (this.value += 1)
  }
}

export class GfsResourceDeepLinkQueue {
  private readonly pending: GfsResourceDeepLinkEnvelope[] = []
  private sequence = 0

  constructor(private readonly maxSize = 20) {}

  list(): GfsResourceDeepLinkEnvelope[] {
    return [...this.pending]
  }

  enqueue(
    target: GfsResourceDeepLinkTarget,
    userNavigationGenerationAtActivation = 0
  ): GfsResourceDeepLinkEnvelope {
    const uri = normalizeGfsResourceUri(target.uri)
    if (!uri) throw new Error('Invalid GFS resource deep link')
    if (
      !Number.isSafeInteger(userNavigationGenerationAtActivation) ||
      userNavigationGenerationAtActivation < 0
    ) {
      throw new Error('Invalid GFS navigation generation')
    }
    const envelope = {
      id: (this.sequence += 1),
      uri,
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
    // IDs never reset; the returned floor lets a renderer reject an in-flight
    // pre-clear event while accepting links activated after this boundary.
    return this.sequence + 1
  }
}

export function createLogoutWithGfsResourceDeepLinkClear(
  queue: GfsResourceDeepLinkQueue,
  logout: () => Promise<number>
): () => Promise<number> {
  return async () => {
    queue.clear()
    try {
      return await logout()
    } finally {
      queue.clear()
    }
  }
}
