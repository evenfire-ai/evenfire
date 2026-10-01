import jwt from 'jsonwebtoken'

export function requireValidRpcAccessTokenAny(_scopes: string[]) {
  return (_req: any, _res: any, next: () => void) => {
    jwt.verify('fixture-token', 'fixture-key')
    next()
  }
}

export function requireValidRpcAccessToken(_scope: string) {
  return (_req: any, _res: any, next: () => void) => {
    jwt.verify('fixture-token', 'fixture-key')
    next()
  }
}

export function requireRpcTokenUserMatch() {
  return (_req: any, _res: any, next: () => void) => next()
}
export function requireRpcTokenHostMatch() {
  return (_req: any, _res: any, next: () => void) => next()
}
