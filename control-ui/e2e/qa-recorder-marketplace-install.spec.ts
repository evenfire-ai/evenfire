// control-ui/e2e/qa-recorder-marketplace-install.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Installs a Marketplace MCP entry through the Package → Credentials →
// Install wizard (asserting the step rail carries no Context step or button),
// follows the success dialog's "Go to Connectors" action, expands the new
// connector ("No agents have access yet."), and grants a seeded agent access
// through the "Add agents" flow. The installed connector, its
// silently-provisioned private scope, and the seeded host + context are
// deleted via the Control API in the finally. Entry discovery mirrors
// qa-recorder-marketplace-browse.spec.ts; the journey skips when no
// installable MCP entry exists.
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the
// recorder").
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  resourceName,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

type RegistryEntrySummary = {
  name: string
  version: string
  status?: string
  entry_type?: string
  server_mode?: string | null
}

type RegistryEntryListResponse = { data?: RegistryEntrySummary[] }

type ContextListItem = { metadata?: { name?: string }; name?: string }

test.describe('optional QA recorder: Control UI marketplace install', () => {
  test('records installing a Marketplace connector and granting an agent access', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey installs and deletes a Marketplace connector and seeds/deletes a host and context.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const journey = 'control-ui-marketplace-install'
    const serverName = uniqueE2EName('qa-recorder-install')
    const contextName = uniqueE2EName('qa-recorder-context')
    const agentName = uniqueE2EName('qa-recorder-agent')

    try {
      await loginThroughUi(page, credentials)

      // Seed an agent (context + host) first so the "Add agents" grant on the
      // Installed Connectors list has a target.
      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: 'QA recorder marketplace install context',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      const hostRes = await api(page.request, 'POST', '/api/v1/admin/hosts', {
        metadata: { name: agentName },
        spec: {
          host: agentName,
          contextRef: contextName,
          secretRef: '',
          channels: [],
          model: { provider: 'openai', name: 'gpt-5.4-mini' },
        },
      })
      expect(hostRes.status, `create host: ${JSON.stringify(hostRes.data)}`).toBeLessThan(300)

      // Entry discovery mirrors qa-recorder-marketplace-browse.spec.ts: probe
      // the registry through the Control UI proxy, then prefer a local MCP
      // entry (remote entries require egress before Continue).
      await page.getByRole('link', { name: 'Marketplace', exact: true }).click()
      await expect(page).toHaveURL(/\/marketplace\/connectors$/, { timeout: 20_000 })

      const { status, data } = await api<RegistryEntryListResponse>(
        page.request,
        'GET',
        '/api/v1/admin/registry/entries'
      )
      const entries = status === 200 ? (data.data ?? []) : []
      const mcpEntries = entries.filter(entry => entry.entry_type === 'mcp-server')
      const localEntries = mcpEntries.filter(entry => entry.server_mode === 'local')
      const candidates = localEntries.length > 0 ? localEntries : mcpEntries
      test.skip(
        candidates.length === 0,
        'No suitable Marketplace MCP entries in this environment; skipping install journey.'
      )

      // Find the first candidate whose catalog row still offers an enabled
      // Install action (already-installed entries show a disabled "Installed").
      const search = page.getByLabel('Search the Marketplace', { exact: true })
      await expect(search).toBeEnabled({ timeout: 20_000 })
      let target: RegistryEntrySummary | undefined
      for (const candidate of candidates) {
        await search.fill(candidate.name)
        const row = page.locator('tr', { hasText: candidate.name }).first()
        await expect(row).toBeVisible({ timeout: 20_000 })
        const install = row.getByRole('button', { name: 'Install', exact: true })
        if ((await install.count()) === 1 && (await install.isEnabled())) {
          target = candidate
          await install.click()
          break
        }
        await search.clear()
      }
      if (!target) {
        test.skip(
          true,
          'Every Marketplace MCP entry is already installed; skipping install journey.'
        )
        return
      }
      const entry = target

      await expect(page).toHaveURL(/\/marketplace\/install\?/, { timeout: 20_000 })
      await expect(
        page.getByRole('heading', { name: 'Install Connector from Marketplace' })
      ).toBeVisible({ timeout: 20_000 })

      // Step rail is exactly Package / Credentials / Install — no Context step.
      const rail = page.locator('.cu-agent-step-rail')
      await expect(rail.locator('.cu-agent-step-rail__title')).toHaveText([
        'Package',
        'Credentials',
        'Install',
      ])
      await expect(rail.getByText(/context/i)).toHaveCount(0)
      await expect(page.getByRole('button').filter({ hasText: /context/i })).toHaveCount(0)

      // Configuration disclosure: name the installed server uniquely.
      const installForm = page.locator('form').filter({ has: page.locator('#ri-name') })
      await expect(installForm).toBeVisible({ timeout: 20_000 })
      await installForm.locator('summary', { hasText: 'Configuration' }).click()
      await installForm.locator('#ri-name').clear()
      await installForm.locator('#ri-name').fill(serverName)
      await screenshotAndLog(page, testInfo, `${journey}-package`)

      // Package → Credentials
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(rail.locator('.cu-agent-step-rail__item').nth(1)).toHaveAttribute(
        'data-state',
        'current'
      )
      await expect(page.locator('body')).not.toContainText(/Select a context|Context access/)

      // Credentials → Install (fill or leave per schema).
      const credentialInputs = installForm.locator('fieldset input')
      const credentialCount = await credentialInputs.count()
      for (let index = 0; index < credentialCount; index += 1) {
        await credentialInputs.nth(index).fill('qa-recorder-credential')
      }
      await screenshotAndLog(page, testInfo, `${journey}-credentials`)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(rail.locator('.cu-agent-step-rail__item').nth(2)).toHaveAttribute(
        'data-state',
        'current'
      )

      // Install summary names the server and the package.
      const summary = page.getByRole('region', { name: 'Install summary' })
      await expect(summary).toBeVisible({ timeout: 20_000 })
      await expect(summary).toContainText(serverName)
      await expect(summary).toContainText(entry.name)
      await expect(page.locator('body')).not.toContainText(/Select a context|Context access/)
      await screenshotAndLog(page, testInfo, `${journey}-summary`)

      await page.getByRole('button', { name: 'Install', exact: true }).click()

      const successDialog = page.getByRole('dialog', {
        name: "Congratulations — you're ready to go",
      })
      await expect(
        successDialog.getByRole('heading', { name: "Congratulations — you're ready to go" })
      ).toBeVisible({ timeout: 60_000 })
      await expect(
        successDialog.getByText(/Give agents access from the Installed Connectors list/)
      ).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-success`)

      await successDialog.getByRole('button', { name: 'Go to Connectors', exact: true }).click()
      await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })

      // The fresh install has no agents yet.
      const row = page.getByRole('row', { name: new RegExp(serverName) })
      await expect(row).toBeVisible({ timeout: 30_000 })
      await row.click()
      await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 })
      const detail = page.locator('.cu-connector-detail')
      await expect(detail).toBeVisible({ timeout: 10_000 })
      await expect(detail.getByText('No agents have access yet.', { exact: true })).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-no-agents`)

      // Grant the seeded agent from the Installed Connectors list.
      await detail.getByRole('button', { name: 'Add agents', exact: true }).click()
      const grantDialog = page.getByRole('dialog', { name: 'Give agents access to this connector' })
      await expect(grantDialog).toBeVisible()
      await grantDialog.getByRole('button', { name: 'Select agents', exact: true }).click()
      await grantDialog.getByRole('option', { name: agentName, exact: true }).click()
      await grantDialog.getByRole('button', { name: 'Add to agent', exact: true }).click()
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: `Connector ${serverName} added to agent ${agentName}.` })
      ).toBeVisible({ timeout: 20_000 })
      await expect(detail.getByText(agentName, { exact: true })).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, `${journey}-agent-granted`)
    } finally {
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(serverName)}`
      )
      // The install silently provisions a private scope (<name>-#####); find
      // it by prefix and tear it down too.
      try {
        const scopesRes = await api<{ items?: ContextListItem[] }>(
          page.request,
          'GET',
          '/api/v1/admin/contexts'
        )
        if (scopesRes.status === 200) {
          const privateScope = (scopesRes.data.items ?? [])
            .map(item => resourceName(item))
            .find(name => new RegExp(`^${serverName}-[0-9]{5}$`).test(name))
          if (privateScope) {
            await api(
              page.request,
              'DELETE',
              `/api/v1/admin/contexts/${encodeURIComponent(privateScope)}`
            )
          }
        }
      } catch {
        // Best-effort private-scope discovery; the connector itself is gone.
      }
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentName)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
