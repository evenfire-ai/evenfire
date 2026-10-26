/**
 * Reads the hostRef of every FleetBoard row (`.agents-table-row-clickable`).
 *
 * The row's <strong> is the agent's display name (e.g. "chatLLM"), which is
 * not a hostRef: an RPC token requested for it is refused, and that refusal
 * fails the status read of every Host in the same request. Every row ends with
 * a mock description in `.agent-row-description`; FleetBoard renders the
 * hostRef in an earlier `.agent-row-description` only when it differs from the
 * display name. So the hostRef is the first description when the row has two,
 * and the <strong> otherwise.
 *
 * Self-contained: Playwright serializes it into the renderer through
 * `locator.evaluateAll(fleetRowHostRefs)`, so it must not reference anything
 * outside its own body.
 */
export function fleetRowHostRefs(rows: Element[]): string[] {
  return rows
    .map(row => {
      const descriptions = row.querySelectorAll('.agent-row-description')
      const hostRef = descriptions.length === 2 ? descriptions[0] : row.querySelector('strong')
      return (hostRef?.textContent ?? '').trim()
    })
    .filter(Boolean)
}
