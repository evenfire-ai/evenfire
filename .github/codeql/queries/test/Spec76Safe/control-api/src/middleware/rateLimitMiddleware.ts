export function createRateLimitEnforcer(_opts: unknown): (...args: any[]) => Promise<boolean> {
  return async () => true
}
