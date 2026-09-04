export function unrelatedMiddleware() {
  return (_req: unknown, _res: unknown, next: () => void) => next()
}

declare function login(): void

export async function requireExternalSessionLimiterIdentityWithPublicErrors(
  _req: unknown,
  _res: unknown,
  next: () => void,
) {
  login()
  next()
}
