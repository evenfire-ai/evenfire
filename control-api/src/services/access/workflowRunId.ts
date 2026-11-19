const CANONICAL_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The id when it is exactly what `run_id::text` renders (lowercase,
 * hyphenated); otherwise null.
 *
 * `workflow_runs.run_id` is a uuid primary key. Comparing `run_id = $n::uuid`
 * uses its index, but the cast would also accept uppercase, braced or
 * unhyphenated input and raise on anything else. Callers validate with this
 * first, so a value matches exactly the rows `run_id::text = $n` matched and a
 * malformed value finds no row instead of failing the statement.
 */
export function canonicalWorkflowRunId(value: string): string | null {
  return CANONICAL_RUN_ID.test(value) ? value : null
}
