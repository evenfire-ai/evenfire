import { type Page, expect } from '@playwright/test'
import type { Scenario } from './approved-tools-scenarios'

// E2E_GUARDIAN_IPC_FLOW: the Host's own connector status reaches the Desktop
// through its main-process status subscription; nothing here is mocked.

// The Host polls a Context's `mcpServers` every 30 s (`mcp-host/src/config.ts`,
// minikube overlay), so three poll periods is the budget for a freshly attached
// connector to reach its live status.
const CONNECTOR_POLL_BUDGET_MS = 90_000
const ROW_VISIBLE_TIMEOUT_MS = 30_000
const READ_INTERVAL_MS = 2_000

/**
 * Witnesses that the agent's own Host has the fixture connector running, before
 * a case sends a turn that needs its tool.
 *
 * A Context `mcpServers` change never rolls the agent Deployment: the Host picks
 * it up by polling, so a Deployment generation wait cannot observe it (run14 R1).
 * This reads the Desktop's "Agent connectors" panel instead, which renders one
 * row per catalog connector from the Host's status snapshot, where `running`
 * means the Host reports the server `connected` with at least one tool
 * (`desktop-app/src/mcpServerHealth.ts`). The panel subscribes to new snapshots,
 * so the row updates on its own.
 */
export async function expectAgentConnectorRunning(desktop: Page, scenario: Scenario) {
  await desktop.getByTestId('nav-mcp-servers').click()
  // The connectors rail lists one row per (connector, agent); the row's
  // aria-label is the deep link into this agent's own Connectors panel.
  await desktop
    .getByRole('button', { name: `Open connectors for agent ${scenario.agentName}`, exact: true })
    .click()
  const row = desktop.getByTestId(`mcp-health-row-${scenario.connectorName}`)
  // The row's presence is the positive witness for the label read below.
  await expect(row).toBeVisible({ timeout: ROW_VISIBLE_TIMEOUT_MS })
  await expect
    .poll(
      async () => {
        const label = (await row.getAttribute('data-label')) ?? 'absent'
        if (label === 'running') return label
        // Report the state that was found, so an expired wait names the Host's
        // own reason (`data-reason`) instead of only a timeout.
        const reason = await row.getAttribute('data-reason')
        return reason ? `${label} (${reason})` : label
      },
      {
        timeout: CONNECTOR_POLL_BUDGET_MS,
        intervals: [READ_INTERVAL_MS],
        message: `Agent ${scenario.agentName} connector ${scenario.connectorName} must report running`,
      }
    )
    .toBe('running')
}
