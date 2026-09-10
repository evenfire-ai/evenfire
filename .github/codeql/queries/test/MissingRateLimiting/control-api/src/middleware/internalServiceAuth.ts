export function requireInternalService(_service: string) {
  return (_req: unknown, _res: unknown, next: () => void): void => next();
}
