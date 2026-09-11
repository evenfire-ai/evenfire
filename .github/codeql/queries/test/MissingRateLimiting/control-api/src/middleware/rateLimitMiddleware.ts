export function rateLimitMiddleware(_policy: unknown) {
  return (_req: unknown, _res: unknown, next: () => void) => next()
}
