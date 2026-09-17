export function requireScope(_scope: string) {
  return async (_req: any, _res: any, next: () => void) => {
    await fetch('https://control-api.example/authorize')
    next()
  }
}
