import jwt from 'jsonwebtoken'

export function requireValidRpcAccessTokenAny(_scopes: string[]) {
  return (_req: any, _res: any, next: () => void) => {
    jwt.verify('fixture-token', 'fixture-key')
    next()
  }
}
