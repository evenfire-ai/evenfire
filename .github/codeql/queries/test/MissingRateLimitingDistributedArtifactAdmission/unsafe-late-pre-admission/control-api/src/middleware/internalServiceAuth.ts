export function requireInternalToken(_req: unknown, _res: unknown, next: () => void) { next() }
export function requireInternalService(_name: string) {
  return (_req: unknown, _res: unknown, next: () => void) => next()
}
