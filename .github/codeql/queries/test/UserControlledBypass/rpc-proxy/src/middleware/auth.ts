export function requireRpcAuth(_req: any, _res: any, next: () => void): void {
  next();
}

export function extractAuthToken(req: any): string {
  return String(req.headers.authorization ?? "");
}

export function requireScope(_scope: string) {
  return (_req: any, _res: any, next: () => void): void => next();
}
