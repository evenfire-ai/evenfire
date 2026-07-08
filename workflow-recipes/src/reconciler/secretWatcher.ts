import { OWNER_RECIPE_LABEL_KEY, SHARED_LABEL_KEY } from './secretOwnership'
import { SecretReverseIndex } from './secretReverseIndex'

/**
 * Pure event-handling logic for watched v1 Secret events. Tracks the last
 * key-set we've seen for each Secret name, debounces bursts (`debounceMs`),
 * and fans reconciles out to dependent recipes via the reverse index.
 *
 * The K8s `watch` HTTP loop is owned by `SecretWatcherK8sLoop`, which calls
 * `handleEvent` once per event. Keeping the logic here lets tests drive it
 * without spinning up a watch.
 */

export type SecretEventType = 'ADDED' | 'MODIFIED' | 'DELETED'

// Ownership labels gate cross-recipe Secret access (Issue #637). A change to
// either one revokes/grants access without touching the Secret's key-set, so the
// watcher must fan out on them too — not just on data changes.
export interface SecretLike {
  metadata?: { name?: string; labels?: Record<string, string> }
  data?: Record<string, string>
  stringData?: Record<string, string>
}

/** Stable signature of a Secret's ownership labels (Issue #637). */
function ownershipSignatureFromLabels(labels: Record<string, string> | undefined): string {
  const l = labels ?? {}
  return `${l[OWNER_RECIPE_LABEL_KEY] ?? ''}|${l[SHARED_LABEL_KEY] ?? ''}`
}

/** Ownership signature for a watch event; '' for a deleted Secret. */
function ownershipSignature(secret: SecretLike, type: SecretEventType): string {
  return type === 'DELETED' ? '' : ownershipSignatureFromLabels(secret.metadata?.labels)
}

export class SecretWatcher {
  private readonly lastSeenKeys = new Map<string, Set<string>>()
  private readonly lastSeenOwnership = new Map<string, string>()
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly reverseIndex: SecretReverseIndex,
    private readonly enqueueReconcile: (recipeName: string) => void,
    private readonly debounceMs: number = 10_000
  ) {}

  /**
   * Process a single v1 Secret watch event. No-ops when neither the key-set NOR
   * the ownership labels changed from the last observation (metadata-only churn
   * like resourceVersion bumps or unrelated annotation edits). A change to the
   * ownership labels (clerum.io/owner-recipe, clerum.io/shared) fans out even
   * when the key-set is unchanged, so a Secret reassigned to a different recipe
   * re-reconciles every referencing recipe and the ownership gate re-evaluates
   * (Issue #637 revocation — otherwise a freshly-denied ref lingers in the pod
   * spec until the next resync).
   */
  handleEvent(type: SecretEventType, secret: SecretLike): void {
    const name = secret.metadata?.name
    if (!name) return

    const newKeys =
      type === 'DELETED'
        ? new Set<string>()
        : new Set<string>([
            ...Object.keys(secret.data ?? {}),
            ...Object.keys(secret.stringData ?? {}),
          ])
    const newOwnership = ownershipSignature(secret, type)

    const prevKeys = this.lastSeenKeys.get(name)
    const prevOwnership = this.lastSeenOwnership.get(name)
    const keysUnchanged = prevKeys !== undefined && setsEqual(prevKeys, newKeys)
    const ownershipUnchanged = prevOwnership !== undefined && prevOwnership === newOwnership
    if (keysUnchanged && ownershipUnchanged) return

    if (type === 'DELETED' && newKeys.size === 0) {
      this.lastSeenKeys.delete(name)
      this.lastSeenOwnership.delete(name)
    } else {
      this.lastSeenKeys.set(name, newKeys)
      this.lastSeenOwnership.set(name, newOwnership)
    }

    this.scheduleFanOut(name)
  }

  /**
   * Seed the watcher's last-known state for a Secret without scheduling a
   * reconcile. Useful when bootstrapping from a `list` response so the first
   * `MODIFIED` event from `watch` doesn't fire a redundant reconcile. Seed the
   * ownership signature too (from the live Secret's labels) so a bootstrap of an
   * already-owned Secret does not spuriously fan out on its first event — the
   * signature must be computed the same way as for watch events.
   */
  primeKnownKeys(
    secretName: string,
    keys: Iterable<string>,
    labels?: Record<string, string>
  ): void {
    this.lastSeenKeys.set(secretName, new Set(keys))
    this.lastSeenOwnership.set(secretName, ownershipSignatureFromLabels(labels))
  }

  /** Clear pending debounce timers. Call on shutdown and from tests. */
  stop(): void {
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
  }

  private scheduleFanOut(secretName: string): void {
    const existing = this.debounceTimers.get(secretName)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.debounceTimers.delete(secretName)
      for (const recipe of this.reverseIndex.recipesFor(secretName)) {
        this.enqueueReconcile(recipe)
      }
    }, this.debounceMs)
    this.debounceTimers.set(secretName, timer)
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}
