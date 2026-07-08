export interface RetryOptions {
  maxAttempts: number;
  backoffSeconds: number;
  onRetry?: (attempt: number, error: Error) => void;
}

const MAX_BACKOFF_SECONDS = 300;

export function computeBackoff(
  backoffSeconds: number,
  attempt: number,
): number {
  const raw = backoffSeconds * Math.pow(2, attempt - 1);
  return Math.min(raw, MAX_BACKOFF_SECONDS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (options.maxAttempts < 1) {
    throw new Error(`withRetry: maxAttempts must be >= 1, got ${options.maxAttempts}`);
  }
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < options.maxAttempts) {
        options.onRetry?.(attempt, lastError);
        const delayMs = computeBackoff(options.backoffSeconds, attempt) * 1000;
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error("withRetry: no attempts were executed");
}
