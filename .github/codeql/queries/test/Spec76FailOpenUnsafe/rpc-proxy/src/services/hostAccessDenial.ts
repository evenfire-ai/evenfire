export function isHostAccessDenied(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'denied' in value
}

export function respondHostAccessDenied(_res: any, _value: unknown): void {}
