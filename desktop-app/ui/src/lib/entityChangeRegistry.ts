import type { EntityChangeScope, EntityChangeStreamEvent } from '../../../src/types'

export type EntityChangeInvalidation = Extract<
  EntityChangeStreamEvent,
  { type: 'scope.invalidated' | 'resync_required' }
>

type ScopeHandler = (event: EntityChangeInvalidation) => void

/** Renderer-side adapter registry; concrete entity families stay transport-agnostic. */
export class EntityChangeRegistry {
  private readonly handlers = new Map<EntityChangeScope, Set<ScopeHandler>>()

  subscribe(scopes: readonly EntityChangeScope[], handler: ScopeHandler): () => void {
    const uniqueScopes = Array.from(new Set(scopes))
    for (const scope of uniqueScopes) {
      const handlers = this.handlers.get(scope) ?? new Set<ScopeHandler>()
      handlers.add(handler)
      this.handlers.set(scope, handlers)
    }
    return () => {
      for (const scope of uniqueScopes) {
        const handlers = this.handlers.get(scope)
        handlers?.delete(handler)
        if (handlers?.size === 0) this.handlers.delete(scope)
      }
    }
  }

  dispatch(event: EntityChangeStreamEvent): void {
    if (event.type !== 'scope.invalidated' && event.type !== 'resync_required') return
    const uniqueHandlers = new Set<ScopeHandler>()
    for (const scope of event.scopes) {
      for (const handler of this.handlers.get(scope) ?? []) uniqueHandlers.add(handler)
    }
    for (const handler of uniqueHandlers) handler(event)
  }
}
