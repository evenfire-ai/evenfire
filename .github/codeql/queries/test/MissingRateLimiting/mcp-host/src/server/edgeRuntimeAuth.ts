export function runtimeEdgeGuard(_input: unknown) {
  return (_req: unknown, _res: unknown, next: () => void): void => next();
}
