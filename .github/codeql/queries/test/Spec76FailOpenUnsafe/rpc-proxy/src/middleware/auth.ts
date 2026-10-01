import jwt from 'jsonwebtoken'

export function requireRpcAuth(_req: any, _res: any, next: () => void): void {
  jwt.verify('fixture-token', 'fixture-key')
  next()
}

export function requireScope(_scope: string) {
  return (_req: any, _res: any, next: () => void) => next()
}

export function requireHostRefCheckpointScope(_scope: string) {
  return (_req: any, _res: any, next: () => void) => next()
}

export function requireHostRpcPreflightScope(_scope: string) {
  return (_req: any, _res: any, next: () => void) => next()
}

export function bindHostRpcScope(_scope: string) {
  return (_req: any, _res: any, next: () => void) => next()
}

export const runHostRefCheckpoint = (_req: any, _res: any, next: () => void) => next()

export function runHostRpcPreflightCheckpoint(_req: any, _res: any, next: () => void): void {
  const parsed = hostRpcRoutePreflight(_req)
  validateHostRef(parsed.hostRef)
  checkpointBoundHostRpcAction(parsed)
  next()
}

function hostRpcRoutePreflight(req: any): any {
  return { hostRef: req.params.hostRef }
}

function validateHostRef(_hostRef: string): void {}

function checkpointBoundHostRpcAction(_parsed: any): void {}

export function extractAuthToken(req: any): string {
  return req.authToken
}
