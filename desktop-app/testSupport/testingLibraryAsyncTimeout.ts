import { afterEach, vi } from 'vitest'

/**
 * The full Desktop suite runs one file at a time and still stalls the event
 * loop past Testing Library's 1s default. A wait that passes alone then fails
 * the pre-gate sync. 4s is long enough for that stall and is not one of the
 * preview retry delays (5s, 10s, 20s, 40s, 60s). A waitFor deadline of 10s
 * is captured by that retry spy and never fires, so the test hangs.
 *
 * A file that leaves fake timers installed also freezes the next file: its
 * real setTimeout never fires, and the test dies at the suite timeout. Restore
 * the real clock after every test.
 */
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/react')
  configure({ asyncUtilTimeout: 4_000 })
}

afterEach(() => {
  vi.useRealTimers()
})
