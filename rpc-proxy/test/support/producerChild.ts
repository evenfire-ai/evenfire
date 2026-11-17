// Shared setup for the rpc-proxy tests that call the Control API producer
// fixtures in a `tsx` child process. The children are setup, not behaviour
// under test: test files start them from a file-level `beforeAll` and record
// each result with `recordSetup`, so no child runs inside a request under test
// or under a test timer. Each test file keeps its own literal producer path,
// because CI discovers producers by searching `*.test.ts` files.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// The bound on a hung child, not an expected duration.
export const PRODUCER_CHILD_TIMEOUT_MS = 240_000
// Room for the module imports a setup hook awaits besides its children.
export const PRODUCER_SETUP_MARGIN_MS = 120_000

// Hook or test timeout for `children` children run one after another. It stays
// above the sum of the child limits, so a slow child is reported by its own
// limit and not by the Vitest timer.
export function producerBudgetMs(children: number): number {
  return children * PRODUCER_CHILD_TIMEOUT_MS + PRODUCER_SETUP_MARGIN_MS
}

// Runs one producer child and resolves with its stdout. The child is awaited, not
// run with `execFileSync`: under Vitest 3.2 a worker blocked for more than 60 s
// fails the run with `Timeout calling "onTaskUpdate"` even when every test passed.
// A child that exceeds the limit is terminated and rejected with an error that
// says so; every other failure is rethrown unchanged.
export async function runProducerChild(
  tsx: string,
  script: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(tsx, [script, ...args], {
      ...options,
      encoding: 'utf8',
      timeout: PRODUCER_CHILD_TIMEOUT_MS,
    })
    return stdout
  } catch (error) {
    if ((error as { killed?: unknown }).killed === true) {
      throw new Error(
        `producer child exceeded ${PRODUCER_CHILD_TIMEOUT_MS} ms and was terminated: ${script}`,
        { cause: error }
      )
    }
    throw error
  }
}

export type SetupOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Records the value of a setup step, or the error it failed with. A recorded
// error is rethrown by `setupValue`: a broken producer fails the tests that read
// it, with its own error, and the other tests still run.
export async function recordSetup<T>(run: () => T | Promise<T>): Promise<SetupOutcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

export function setupValue<T>(outcome: SetupOutcome<T> | undefined, name: string): T {
  if (!outcome) throw new Error(`${name} was not set up in beforeAll`)
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
