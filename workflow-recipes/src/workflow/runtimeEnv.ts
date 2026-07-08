export function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`)
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }

  return parsed
}
