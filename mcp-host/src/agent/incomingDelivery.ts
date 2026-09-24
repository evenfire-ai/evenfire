import { MessageQueue } from '../queue/messageQueue'
import type { IncomingMessage, MessageResponse } from '../server/types'

/**
 * Model CAS precedes queue admission. Coalesce that preparation window so two
 * re-forwards cannot mutate the selection twice. Once admitted, the queue's
 * existing lifecycle-backed replay remains the only source of delivery history.
 */
export class IncomingDelivery {
  private readonly preparing = new Map<string, Promise<MessageResponse>>()

  run(
    message: IncomingMessage,
    queue: MessageQueue,
    prepareAndDispatch: () => MessageResponse | Promise<MessageResponse>,
    replay: () => MessageResponse | Promise<MessageResponse>
  ): MessageResponse | Promise<MessageResponse> {
    if (queue.hasAdmittedDelivery(message)) return replay()
    const key = MessageQueue.deliveryKeyOf(message)
    if (!key) return prepareAndDispatch()
    const pending = this.preparing.get(key)
    if (pending) return pending
    // Register before invoking preparation, including synchronous re-entry.
    const response = Promise.resolve().then(prepareAndDispatch)
    const settled = response.finally(() => {
      if (this.preparing.get(key) === settled) this.preparing.delete(key)
    })
    this.preparing.set(key, settled)
    return settled
  }
}
