import { GfsError } from "../api/errors";

export interface DeadlineBudget {
  deadlineAtMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface DeadlineClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(error?: Error | boolean): void;
}

export interface DeadlinePool {
  connect?: () => Promise<DeadlineClient>;
}

export class DeadlineCommitOutcomeUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super("deadline-bounded transaction commit outcome is unknown");
    this.name = "DeadlineCommitOutcomeUnknownError";
  }
}

export class DeadlineRollbackOutcomeUnknownError extends Error {
  constructor(readonly cause: unknown, readonly rollbackCause: unknown) {
    super("deadline-bounded transaction rollback outcome is unknown");
    this.name = "DeadlineRollbackOutcomeUnknownError";
  }
}

function remainingMs(budget: DeadlineBudget): number {
  budget.signal?.throwIfAborted();
  const remaining = budget.deadlineAtMs - (budget.now ?? Date.now)();
  if (remaining <= 0) throw new GfsError("precondition_failed", "synchronous mutation deadline exceeded");
  return Math.max(1, Math.min(remaining, 2_147_483_647));
}

function deadlineError(error: unknown, budget: DeadlineBudget): boolean {
  return (error as { code?: string }).code === "57014"
    || budget.signal?.aborted === true
    || (budget.now ?? Date.now)() >= budget.deadlineAtMs;
}

const MAX_TIMER_MS = 2_147_483_647;

export async function acquireBeforeDeadline(
  connect: () => Promise<DeadlineClient>,
  budget: DeadlineBudget
): Promise<DeadlineClient> {
  if (budget.signal?.aborted || (budget.now ?? Date.now)() >= budget.deadlineAtMs) {
    throw new GfsError("precondition_failed", "synchronous mutation deadline exceeded");
  }
  let orphaned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const acquire = connect();
  // Promise.race cannot cancel pool.connect(). If the deadline wins, return a
  // client that arrives later without ever issuing SQL. Handle late rejection
  // too, so neither outcome can become an unhandled promise rejection.
  void acquire.then(
    client => {
      if (!orphaned) return;
      try {
        client.release();
      } catch {
        // release() is synchronous and there is no further recovery action;
        // swallowing here prevents a late cleanup error from going unhandled.
      }
    },
    () => undefined
  );

  const deadline = new Promise<never>((_, reject) => {
    let remainingToWait = budget.deadlineAtMs - (budget.now ?? Date.now)();
    const rejectDeadline = () => {
      // Mark the acquire orphaned before settling the deadline promise. This
      // keeps cleanup correct even when connect resolves in the narrow window
      // before the awaiting continuation runs.
      orphaned = true;
      reject(new GfsError("precondition_failed", "synchronous mutation deadline exceeded"));
    };
    const armDeadline = () => {
      if (remainingToWait <= 0 || (budget.now ?? Date.now)() >= budget.deadlineAtMs) {
        rejectDeadline();
        return;
      }
      // Node clamps larger delays to 1ms. Re-arm at its supported maximum so
      // a valid long deadline never expires early.
      const delay = Math.max(1, Math.min(remainingToWait, MAX_TIMER_MS));
      remainingToWait -= delay;
      timer = setTimeout(armDeadline, delay);
      timer.unref?.();
    };
    armDeadline();
    if (budget.signal) {
      if (budget.signal.aborted) {
        rejectDeadline();
      } else {
        abortListener = rejectDeadline;
        budget.signal.addEventListener("abort", abortListener, { once: true });
      }
    }
  });

  try {
    return await Promise.race([acquire, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) budget.signal?.removeEventListener("abort", abortListener);
  }
}

/** A dedicated short transaction whose timeout is installed before useful SQL. */
export async function withDeadlineTransaction<T>(
  pool: DeadlinePool,
  budget: DeadlineBudget,
  readOnly: boolean,
  operation: (client: DeadlineClient) => Promise<T>
): Promise<T> {
  if (!pool.connect) throw new Error("deadline-bounded database operation requires a checked-out client");
  const client = await acquireBeforeDeadline(() => pool.connect!(), budget);
  let commitSent = false;
  let poison: Error | undefined;
  try {
    budget.signal?.throwIfAborted();
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(remainingMs(budget))]);
    const result = await operation(client);
    remainingMs(budget);
    commitSent = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    let rollbackFailure: unknown;
    await client.query("ROLLBACK").catch(failure => { rollbackFailure = failure; });
    if (commitSent || rollbackFailure !== undefined) {
      const cause = rollbackFailure ?? error;
      poison = cause instanceof Error ? cause : new Error(String(cause));
    }
    if (commitSent) throw new DeadlineCommitOutcomeUnknownError(error);
    if (rollbackFailure !== undefined) {
      throw new DeadlineRollbackOutcomeUnknownError(error, rollbackFailure);
    }
    if (deadlineError(error, budget)) {
      throw new GfsError("precondition_failed", "synchronous mutation deadline exceeded");
    }
    throw error;
  } finally {
    client.release(poison);
  }
}
