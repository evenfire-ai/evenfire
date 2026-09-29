import jwt from 'jsonwebtoken'

export function requireRpcAuth(_req: any, _res: any, next: () => void): void {
  jwt.verify('fixture-token', 'fixture-key')
  next()
}

export function requireScope(_scope: string) {
  return (_req: any, _res: any, next: () => void) => next()
}

export function extractAuthToken(req: any): string {
  return req.authToken
}
