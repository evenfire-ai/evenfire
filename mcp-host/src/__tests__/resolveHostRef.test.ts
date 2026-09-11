import { describe, expect, it } from 'vitest'
import { resolveHostRef } from '../main'
import type { Task } from '../queue/types'
import type { IncomingMessage } from '../server'
import type { HostCRD } from '../types'

// F0.1 / UT-8 — resolveHostRef must fall back to the CRD identifier
// (`metadata.name`, RFC1123, referenced across the whole system), NOT the
// freely-editable display name in `spec.host`. With an editable display,
// `spec.host` can be arbitrary free text (e.g. "Product Agents") that is not a
// valid ref, so using it as the identifier fallback would publish activity
// events under a non-existent hostRef. See spec §4 F0.1 and Locked decision #5.

function makeHost(overrides: Partial<HostCRD> = {}): HostCRD {
  return {
    name: 'product-agent',
    namespace: 'default',
    spec: {
      host: 'Product Agents',
      contextRef: 'product-context',
      secretRef: 'product-llm-secret',
    },
    ...overrides,
  }
}

function makeTask(hostRef: string): Task {
  const sourceMessage = {
    content: 'hi',
    channelType: 'rpc',
    channelId: 'chan-1',
    sender: 'user-1',
    timestamp: new Date().toISOString(),
    messageId: 'msg-1',
    hostRef,
  } as IncomingMessage
  return { sourceMessage } as unknown as Task
}

describe('resolveHostRef (F0.1 / UT-8)', () => {
  it('falls back to the CRD name, not the display spec.host, when the task carries no hostRef', () => {
    const host = makeHost({
      name: 'product-agent',
      spec: { ...makeHost().spec, host: 'Product Agents' },
    })

    // No sourceMessage.hostRef → must resolve to the identifier `product-agent`,
    // never the display `Product Agents`.
    expect(resolveHostRef(undefined, host)).toBe('product-agent')
  })

  it('still prefers an explicit sourceMessage.hostRef over the fallback', () => {
    const host = makeHost()
    expect(resolveHostRef(makeTask('explicit-ref'), host)).toBe('explicit-ref')
  })
})
