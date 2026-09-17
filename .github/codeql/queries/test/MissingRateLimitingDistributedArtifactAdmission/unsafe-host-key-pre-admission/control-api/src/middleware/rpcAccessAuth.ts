declare function verifyToken(): void

export function requireValidRpcAccessTokenAny(_scopes: string[]) {
  return (_req: unknown, _res: unknown, next: () => void) => {
    verifyToken()
    next()
  }
}

export function requireRpcTokenUserMatch() {
  return (_req: unknown, _res: unknown, next: () => void) => next()
}

export function requireRpcTokenHostMatch() {
  return (_req: unknown, _res: unknown, next: () => void) => next()
}
