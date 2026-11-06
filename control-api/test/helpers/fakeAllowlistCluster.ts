/**
 * Kubernetes ConfigMap API fake with the apiserver semantics the allowlist
 * writer depends on, so a test can observe lost updates instead of assuming
 * them away:
 *   - `read` of a missing object → 404;
 *   - `create` of an existing object → 409;
 *   - `replace` whose `metadata.resourceVersion` is not the current one → 409;
 *   - every successful write bumps `resourceVersion`.
 *
 * `hooks` let a test park a call (before it reaches the store, or after the
 * store answered) to drive an interleaving explicitly.
 */
import type * as k8s from '@kubernetes/client-node'
import type { Pool } from 'pg'

type Phase = 'read' | 'create' | 'replace'

export interface FakeConfigMapApiHooks {
  /** Awaited before the call reaches the store. */
  before?: (phase: Phase, body?: k8s.V1ConfigMap) => Promise<void> | void
  /** Awaited after the store answered, before the caller sees the answer. */
  after?: (phase: Phase) => Promise<void> | void
}

function apiError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export class FakeConfigMapApi {
  current: k8s.V1ConfigMap | null = null
  writes = 0
  reads = 0
  conflicts = 0
  private rv = 0
  private failures: Error[] = []
  hooks: FakeConfigMapApiHooks = {}
  /** Answer reads without `metadata.resourceVersion` (a malformed apiserver reply). */
  omitResourceVersionOnRead = false

  /** The next `n` write calls (create or replace) fail with `err` before touching the store. */
  failNextWrites(n: number, err: Error = apiError(503, 'apiserver unavailable')): void {
    for (let i = 0; i < n; i++) this.failures.push(err)
  }

  /** Drop write failures armed by `failNextWrites` that no write consumed yet. */
  clearPendingFailures(): void {
    this.failures = []
  }

  get data(): Record<string, string> | undefined {
    return this.current?.data
  }

  get annotations(): Record<string, string> | undefined {
    return this.current?.metadata?.annotations
  }

  get resourceVersion(): string | undefined {
    return this.current?.metadata?.resourceVersion
  }

  readNamespacedConfigMap = async (_req: {
    namespace: string
    name: string
  }): Promise<k8s.V1ConfigMap> => {
    await this.hooks.before?.('read')
    this.reads += 1
    const snapshot = this.current ? structuredClone(this.current) : null
    if (snapshot && this.omitResourceVersionOnRead) delete snapshot.metadata?.resourceVersion
    await this.hooks.after?.('read')
    if (!snapshot) throw apiError(404, 'not found')
    return snapshot
  }

  createNamespacedConfigMap = async (req: {
    namespace: string
    body: k8s.V1ConfigMap
  }): Promise<k8s.V1ConfigMap> => {
    await this.hooks.before?.('create', req.body)
    const failure = this.failures.shift()
    if (failure) throw failure
    if (this.current) {
      this.conflicts += 1
      await this.hooks.after?.('create')
      throw apiError(409, 'already exists')
    }
    this.store(req.body)
    await this.hooks.after?.('create')
    return structuredClone(this.current!)
  }

  replaceNamespacedConfigMap = async (req: {
    namespace: string
    name: string
    body: k8s.V1ConfigMap
  }): Promise<k8s.V1ConfigMap> => {
    await this.hooks.before?.('replace', req.body)
    const failure = this.failures.shift()
    if (failure) throw failure
    if (!this.current) throw apiError(404, 'not found')
    if (req.body.metadata?.resourceVersion !== this.current.metadata?.resourceVersion) {
      this.conflicts += 1
      await this.hooks.after?.('replace')
      throw apiError(409, 'resourceVersion conflict')
    }
    this.store(req.body)
    await this.hooks.after?.('replace')
    return structuredClone(this.current!)
  }

  private store(body: k8s.V1ConfigMap): void {
    this.rv += 1
    this.writes += 1
    const next = structuredClone(body)
    next.metadata = { ...(next.metadata ?? {}), resourceVersion: String(this.rv) }
    this.current = next
  }
}

type FakeQuery = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount: number | null }>

/**
 * Adapts an in-memory query function to the `pg.Pool` surface `withTransaction`
 * uses on the no-signal path (connect → query/on/removeListener/release).
 */
export function poolFromQuery(query: FakeQuery): Pool {
  return {
    connect: async () => ({
      query,
      on: () => undefined,
      removeListener: () => undefined,
      release: () => undefined,
    }),
  } as unknown as Pool
}
