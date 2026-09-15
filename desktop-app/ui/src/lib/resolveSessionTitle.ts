/**
 * Session-title precedence resolver (spec 15 §2.2 — the D3 decision module).
 *
 * Pure function that answers a single question for one session: "which title do
 * I show, and where did it come from?", given the local cache state, the
 * server-reported title, and whether a local rename is pending.
 *
 * The invariant (§2.2): the server wins when it has a title AND there is no
 * pending local rename for that session; a pending local rename wins over the
 * server until it is confirmed or rolled back.
 *
 * Decision table:
 *
 *  | Case | inCache | pendingRename | serverTitle | -> source     |
 *  |------|---------|---------------|-------------|---------------|
 *  |  A   |   no    |    none       |   present   |  server       |
 *  |  B   |   no    |    none       |   absent    |  placeholder  |
 *  |  C   |   yes   |    none       |   present   |  server       |
 *  |  D   |   yes   |    none       |   absent    |  local        |
 *  |  E   |   yes   |  in-flight    |   any       |  local        |
 *  |  F   |   yes   |   offline     |   any       |  local        |
 *
 * PHASE SCOPE: cases A–D are exercised now (Fase A / desktop). Cases E and F
 * (optimistic rename in-flight / offline queue) belong to Fase B: `pendingRename`
 * is part of the signature and the table today, but every caller passes 'none'
 * until Fase B populates the pending-rename queue. The 'in-flight'/'offline'
 * branches already return the local title, which is exactly what Fase B needs —
 * Fase B only has to feed the real pending state; it does not restructure this
 * module.
 */

/**
 * Pending-rename state for a session. 'none' in Fase A; 'in-flight' (optimistic
 * PATCH awaiting confirmation) and 'offline' (queued for reconnect) arrive in
 * Fase B.
 */
export type PendingRename = 'none' | 'in-flight' | 'offline'

export type TitleSource = 'server' | 'local' | 'placeholder'

export interface ResolveSessionTitleInput {
  /** Whether the client has this session in its local chat cache/index. */
  inCache: boolean
  /** The local cache title (only meaningful when `inCache`). */
  localTitle?: string
  /** The sanitized server title, if the host reported one. */
  serverTitle?: string
  /** Local rename state for this session. Always 'none' in Fase A. */
  pendingRename: PendingRename
  /** Placeholder to show for a server-only session with no title (case B). */
  placeholder: string
}

export interface ResolvedSessionTitle {
  title: string
  source: TitleSource
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

export function resolveSessionTitle(input: ResolveSessionTitleInput): ResolvedSessionTitle {
  const hasServer = hasText(input.serverTitle)
  const hasLocal = input.inCache && hasText(input.localTitle)

  // E/F: a pending local rename wins over the server until it is confirmed.
  // (Fase B; in Fase A `pendingRename` is always 'none' so this never fires.)
  if (input.pendingRename !== 'none' && hasLocal) {
    return { title: input.localTitle as string, source: 'local' }
  }

  // A/C: server-authoritative when it has a title and nothing local is pending.
  if (hasServer) {
    return { title: input.serverTitle as string, source: 'server' }
  }

  // D: a cached local name survives as fallback when the server has none.
  if (hasLocal) {
    return { title: input.localTitle as string, source: 'local' }
  }

  // B: server-only session with no title yet.
  return { title: input.placeholder, source: 'placeholder' }
}
