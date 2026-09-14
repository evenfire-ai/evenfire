export function requireInternalService(_service: string) {
  return (_req: unknown, _res: unknown, next: () => void): void => next();
}

export function requireInternalToken(_req: any, _res: any, next: () => void): void {
  next();
}
