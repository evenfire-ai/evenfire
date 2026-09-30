import type { TestProject } from 'vitest/node'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

declare module 'vitest' {
  export interface ProvidedContext {
    mockClerumStoreRoot: string
  }
}

/**
 * Vitest global setup for the `mockClerum` fixture: one temporary root per run
 * that holds every per-install `ChatStore` directory.
 *
 * A hook can still be writing through the store after a test unmounts it, and
 * that write recreates a per-install directory the fixture has already
 * removed. Removing the whole root here runs after every test file has
 * finished, so no directory outlives the run.
 */
export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), 'mockclerum-'))
  project.provide('mockClerumStoreRoot', root)
  return () => {
    rmSync(root, { recursive: true, force: true })
  }
}
