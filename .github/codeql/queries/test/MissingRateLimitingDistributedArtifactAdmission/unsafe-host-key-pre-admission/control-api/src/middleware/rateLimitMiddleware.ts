export function rateLimitMiddleware(_options: unknown) {
  return (_req: unknown, _res: unknown, next: () => void) => next()
}
