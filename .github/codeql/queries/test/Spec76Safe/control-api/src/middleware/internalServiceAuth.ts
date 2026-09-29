export function requireInternalService(_name: string) {
  return (_req: any, _res: any, next: () => void) => next()
}
