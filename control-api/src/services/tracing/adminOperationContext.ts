import { AsyncLocalStorage } from 'node:async_hooks'

export type AdministrativeRequestContext = {
  operatorSub: string
  requestId: string | null
}

const storage = new AsyncLocalStorage<AdministrativeRequestContext>()

export function runWithAdministrativeRequestContext<T>(
  context: AdministrativeRequestContext,
  work: () => T
): T {
  return storage.run(context, work)
}

export function currentAdministrativeRequestContext(): AdministrativeRequestContext | null {
  return storage.getStore() ?? null
}
