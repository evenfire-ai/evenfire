import type { GfsBulkShareSubjectInput } from '../lib/api'

type AssertNever<T extends never> = T

/**
 * Control UI bulk shares intentionally exclude host subjects. Keep this
 * contract outside test-file paths so the production Next typecheck enforces
 * it even though Next filters diagnostics from __tests__ and *.test.* files.
 */
export type GfsBulkShareMustExcludeHost = AssertNever<
  Extract<GfsBulkShareSubjectInput, { type: 'host' }>
>
