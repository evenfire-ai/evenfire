/**
 * Fase 6 — soft quarantine of `stale` models (operator write path only).
 *
 * The Fase 4 catalog sync flags models that vanished from the external catalog as
 * `stale=true` WITHOUT disabling them (`enabled` stays intact — they still work).
 * When the operator assigns such a model to something NEW (editing a Host,
 * upserting a grant), the write SUCCEEDS (200/201) and carries this informational,
 * NON-BLOCKING warning in the response body.
 *
 * NEVER a 422/409 for `stale` alone: the flag is heuristic and flappy and the
 * model still functions. This is orthogonal to Fase 2's `enabled=false` gate — a
 * `stale` model is `enabled`, so it passes `model_not_allowed`; Fase 6 only ADDS
 * the warning when the assignment is new. Live references are never revalidated.
 *
 * The shape is shared by the Host and grant write paths so it cannot drift; the
 * success response gains an additive `warnings: StaleModelWarning[]` field (older
 * clients ignore it).
 */
export const STALE_MODEL_ASSIGNED = 'stale_model_assigned' as const

export interface StaleModelWarning {
  code: typeof STALE_MODEL_ASSIGNED
  provider: string
  model: string
  /** Request-body field the stale assignment arrived on (e.g. `spec.model.name`). */
  field: string
}
