import type { GfsWatchClient } from '../../../../src/gfs/watchClient.js'
import type {
  GfsWatchEvent,
  GfsWatchSubscriptionRequest,
  GfsWatchSubscriptionResult,
} from '../../../../src/types.js'
import { FakeOwner } from '../../../../testSupport/gfsWatch/fakeOwner.js'

/** A window as main's watch client sees it, whose events also reach the renderer listener. */
export class ForwardingOwner extends FakeOwner {
  /** One per `open`, as the preload installs one `ipcRenderer` listener per call. */
  readonly listeners = new Set<(event: GfsWatchEvent) => void>()

  override send(event: GfsWatchEvent): void {
    super.send(event)
    for (const listener of this.listeners) listener(structuredClone(event))
  }
}

type GfsWatchBridge = Window['clerum']['gfsWatch']

/**
 * `window.clerum.gfsWatch` for a renderer test, with main's real watch client
 * behind it: what the preload does (listener first, then the first request)
 * straight onto `client.setSubscriptions`/`stopOwner` for one owner, skipping
 * only the IPC hop. Every request the renderer made is kept, in order.
 */
export function gfsWatchBridgeFor(client: GfsWatchClient, owner: ForwardingOwner) {
  const requests: GfsWatchSubscriptionRequest[] = []
  let opens = 0
  let closes = 0
  const send = (request: GfsWatchSubscriptionRequest): GfsWatchSubscriptionResult => {
    const copy = structuredClone({ keys: request.keys, userId: request.userId })
    requests.push(copy)
    return structuredClone(client.setSubscriptions(owner, copy, owner.frameToken))
  }
  const bridge: GfsWatchBridge = {
    open: async (onEvent, initial) => {
      opens += 1
      owner.listeners.add(onEvent)
      const first = send(initial)
      return {
        sessionExpired: first.sessionExpired,
        setSubscriptions: async request => send(request),
        close: async () => {
          closes += 1
          owner.listeners.delete(onEvent)
          client.stopOwner(owner, owner.frameToken)
        },
      }
    },
  }
  return {
    bridge,
    requests,
    owner,
    /** Hands events captured from the client to the renderer's listener. */
    deliver(events: readonly GfsWatchEvent[]) {
      for (const event of events) {
        for (const listener of owner.listeners) listener(structuredClone(event))
      }
    },
    get opens() {
      return opens
    },
    get closes() {
      return closes
    },
  }
}
