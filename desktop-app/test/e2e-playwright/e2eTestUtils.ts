import { test } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const verifiedExecutables = new Set<string>()

export function requireExecutable(command: string, reason: string): void {
  if (verifiedExecutables.has(command)) return
  try {
    execFileSync('/usr/bin/env', ['which', command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5_000,
    })
    verifiedExecutables.add(command)
  } catch {
    throw new Error(`${command} is required for ${reason}`)
  }
}

export async function watchdogStep<T>(
  name: string,
  timeoutMs: number,
  body: () => Promise<T> | T,
  options: { timeoutLabel?: string } = {}
): Promise<T> {
  return test.step(name, async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(body),
        new Promise<never>((_, reject) => {
          const timeoutLabel = options.timeoutLabel ?? `step: ${name}`
          timeout = setTimeout(
            () => reject(new Error(`watchdog timeout after ${timeoutMs}ms in ${timeoutLabel}`)),
            timeoutMs
          )
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })
}
