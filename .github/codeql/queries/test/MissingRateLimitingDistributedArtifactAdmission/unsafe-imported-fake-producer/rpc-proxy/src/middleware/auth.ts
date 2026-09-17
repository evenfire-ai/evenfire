declare function verifyRpcToken(): void
export function requireRpcAuth(_req: unknown, _res: unknown, next: () => void) { verifyRpcToken(); next() }
export function requireScope(_scope: string) {
  return (_req: unknown, _res: unknown, next: () => void) => next()
}
export function extractAuthToken(_req: unknown): string { return 'token' }
