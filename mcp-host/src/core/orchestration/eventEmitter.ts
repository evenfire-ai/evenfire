import { AgentEventEmitter } from '../interfaces'
import { AgentEvent } from '../types'

/**
 * Simple typed event emitter for agent lifecycle events.
 *
 * Not using Node.js EventEmitter to keep the dependency explicit
 * and allow the interface to be implemented in non-Node contexts.
 */
export class SimpleEventEmitter implements AgentEventEmitter {
  private handlers = new Map<string, Set<(event: AgentEvent) => void>>()

  emit(event: AgentEvent): void {
    const typeHandlers = this.handlers.get(event.type)
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(event)
        } catch (err) {
          console.error(`[EventEmitter] Handler error for ${event.type}:`, err)
        }
      }
    }
  }

  on(type: AgentEvent['type'], handler: (event: AgentEvent) => void): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)
  }

  off(type: AgentEvent['type'], handler: (event: AgentEvent) => void): void {
    this.handlers.get(type)?.delete(handler)
  }
}
