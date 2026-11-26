import type { Page } from '@playwright/test'

/** Exact resource identity; independent of display labels and reference substrings. */
export function fleetAgentSelector(ref: string): string {
  return `.agents-table-row-clickable[data-agent-ref=${JSON.stringify(ref)}]`
}

export async function agentDisplayName(page: Page, ref: string): Promise<string> {
  return page.evaluate(async agentRef => {
    const catalog = await window.clerum.access.refreshCatalog()
    return catalog.agentDisplayByName?.[agentRef] ?? agentRef
  }, ref)
}
