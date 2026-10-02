import { runMigration } from './canonicalStoreInit'
import type { InitOutcome, MigrationOptions } from './types'

/** Legacy compatibility uses the same per-file journal and never writes an identity. */
export function layoutPrecheck(
  root: string,
  options: Omit<MigrationOptions, 'writer'>
): Promise<InitOutcome> {
  return runMigration(root, { ...options, writer: 'layout-precheck' })
}
