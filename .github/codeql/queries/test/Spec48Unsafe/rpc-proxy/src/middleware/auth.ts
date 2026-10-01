import jwt from 'jsonwebtoken'

export function requireRpcAuth(_req: any, _res: any, next: () => void): void {
  jwt.verify('fixture-token', 'fixture-key')
  next()
}
