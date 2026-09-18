import { authorizeBoundRequestV2 } from '../routeActionBindingV2.js'

declare function verifyRpcToken(): void
export function requireRpcAuth(_req: unknown, _res: unknown, next: () => void) { verifyRpcToken(); next() }
export function requireScope(scope: string) {
  return (req: any, res: any, next: () => void) => {
    if (req.userDelegationV2) {
      void authorizeBoundRequestV2(req, res, next)
      return
    }
    const auth = req.auth
    if (!auth || !auth.scopes.includes(scope)) {
      res.status(403).json({ error: 'Forbidden: missing scope' })
      return
    }
    next()
  }
}
export function extractAuthToken(_req: unknown): string { return 'token' }
