/**
 * Reads the hostRef of every FleetBoard row (`.agents-table-row-clickable`).
 *
 * The row's <strong> is the agent's display name (e.g. "chatLLM"), which is
 * not a hostRef: an RPC token requested for it is refused, and that refusal
 * fails the status read of every Host in the same request. The row renders only
 * that display name as copy, so FleetBoard carries the hostRef on the row's
 * `data-agent-ref` attribute.
 *
 * Self-contained: Playwright serializes it into the renderer through
 * `locator.evaluateAll(fleetRowHostRefs)`, so it must not reference anything
 * outside its own body.
 */
export function fleetRowHostRefs(rows: Element[]): string[] {
  return rows.map(row => (row.getAttribute('data-agent-ref') ?? '').trim()).filter(Boolean)
}
