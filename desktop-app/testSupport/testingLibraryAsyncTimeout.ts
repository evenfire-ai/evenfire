/**
 * The full Desktop suite runs one file at a time and still stalls the event
 * loop past Testing Library's 1s default. A wait that passes alone then fails
 * the pre-gate sync. Give findBy/waitFor the same kind of budget as the 30s
 * Vitest test timeout, without making a passing assertion wait.
 */
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/react')
  configure({ asyncUtilTimeout: 10_000 })
}
