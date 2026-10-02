export function unrelatedMiddleware() {
  return (_req: unknown, _res: unknown, next: () => void) => next()
}
