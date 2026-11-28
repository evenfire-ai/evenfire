import { type Page, expect, test } from '@playwright/test'
import { build } from 'esbuild'
import path from 'node:path'
import { HOST_REF, enterAgentChat } from './crossDeviceSessions.helpers.js'
import type { Seed } from './fixtures/identity-presentation/adapter'
import { fleetAgentSelector } from './helpers/agentIdentity.js'
import { startAgentChatFromFleet } from './helpers/agentNavigation.js'
import { openAgentsPage } from './navigationHelpers.js'
import { openExactAgentChat } from './qa-recorder-helpers.js'

let script: string
let css: string
test.beforeAll(async () => {
  const adapter = path.resolve(__dirname, 'fixtures/identity-presentation/adapter.tsx')
  const aliases = [
    '@contexts/AuthContext',
    '@contexts/NavigationContext',
    '@contexts/AgentChatActionsContext',
    '@contexts/AgentActivityContext',
    '@contexts/ChatListContext',
    '@hooks/domain/useAgentsDataController',
    '@hooks/domain/useTeamsDataController',
    '@hooks/domain/useMcpServersDataController',
  ]
  const result = await build({
    entryPoints: [path.resolve(__dirname, 'fixtures/identity-presentation/renderer.tsx')],
    bundle: true,
    write: false,
    outdir: path.resolve(__dirname, 'test-results/agent-identity-bundle'),
    jsx: 'automatic',
    tsconfig: path.resolve(__dirname, '../../ui/tsconfig.json'),
    define: { __DESKTOP_APP_VERSION__: '"identity-fixture"', 'import.meta.env': '{}' },
    alias: Object.fromEntries(aliases.map(alias => [alias, adapter])),
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
    plugins: [
      {
        name: 'unused-file-tree-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/FileExplorerTree$/ }, args =>
            args.importer.endsWith('/SidebarNav/index.tsx')
              ? { path: 'empty-tree', namespace: 'identity-fixture' }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: 'identity-fixture' }, () => ({
            contents: 'export function FileExplorerTree() { return null }',
          }))
        },
      },
    ],
  })
  script = result.outputFiles.find(file => file.path.endsWith('.js'))!.text
  css = result.outputFiles.find(file => file.path.endsWith('.css'))!.text
})

async function seedRenderer(page: Page, seed: Seed) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('https://identity.example/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html data-theme="dark"><body><div id="root"></div></body></html>',
    })
  )
  await page.goto('https://identity.example/')
  await page.evaluate(seed => {
    window.__identitySeed = seed
  }, seed)
  await page.addStyleTag({
    content:
      css +
      '\n.app-frame{display:flex;height:100vh;overflow:hidden}.app-frame main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:auto}body{margin:0}',
  })
  await page.addScriptTag({ content: script })
  try {
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  } catch (error) {
    throw new Error(`Seeded renderer failed: ${errors.join('; ')}`, { cause: error })
  }
}

test('shared stateless/cross-device navigation uses exact refs with different display names and substrings', async ({
  page,
}) => {
  const longerRef = `${HOST_REF}-prod`
  await seedRenderer(page, {
    refs: [longerRef, HOST_REF],
    names: { [HOST_REF]: 'Customer Support', [longerRef]: 'Production Support' },
    sessions: [],
  })
  await expect(page.locator(fleetAgentSelector(HOST_REF))).toContainText('Customer Support')
  await expect(page.locator(fleetAgentSelector(longerRef))).toContainText('Production Support')
  await enterAgentChat(page)
  await expect(page.getByRole('button', { name: 'Switch chat agent', exact: true })).toHaveText(
    'Customer Support'
  )
  await openAgentsPage(page)
  await startAgentChatFromFleet(page, longerRef)
  await expect(page.getByRole('button', { name: 'Switch chat agent', exact: true })).toHaveText(
    'Production Support'
  )
  await openExactAgentChat(page, HOST_REF)
  expect(
    await page.evaluate(() =>
      window.__identityControl.events
        .filter(event => event.action === 'create')
        .map(event => event.ref)
    )
  ).toEqual([HOST_REF, longerRef, HOST_REF])
})

test('final rendered labels, composed session names, navigation and catalog refresh stay unambiguous', async ({
  page,
}) => {
  await seedRenderer(page, {
    refs: ['support-staging', 'support', 'support-production'],
    names: {
      'support-staging': 'Customer Support',
      support: 'Customer Support',
      'support-production': 'Customer Support (support-staging)',
    },
    sessions: [
      { agentRef: 'support', id: 'chat-1', title: 'Task' },
      { agentRef: 'support', id: 'chat-2', title: 'Task' },
      {
        agentRef: 'support-production',
        id: 'chat-3',
        title: 'Task (Customer Support (support) · chat-1)',
      },
    ],
  })
  const labels = await page.locator('.agent-row-main-copy strong').allTextContents()
  expect(new Set(labels).size).toBe(3)
  await expect(page.locator(fleetAgentSelector('support-production'))).toContainText(
    'Customer Support (support-staging)'
  )
  const sessions = page.getByTestId('latest-session-row')
  const names = await sessions
    .locator('.nav-latest-session__main')
    .evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
  expect(new Set(names).size).toBe(3)
  for (const [ref, id] of [
    ['support', 'chat-1'],
    ['support', 'chat-2'],
    ['support-production', 'chat-3'],
  ]) {
    await page
      .locator(
        `[data-testid="latest-session-row"][data-agent-ref=${JSON.stringify(ref)}][data-chat-id=${JSON.stringify(id)}]`
      )
      .getByRole('button', { name: /^Open / })
      .click()
  }
  expect(
    await page.evaluate(() =>
      window.__identityControl.events.filter(event => event.id).map(event => [event.ref, event.id])
    )
  ).toEqual([
    ['support', 'chat-1'],
    ['support', 'chat-2'],
    ['support-production', 'chat-3'],
  ])
  await page.evaluate(() =>
    window.__identityControl.refresh({
      support: 'Main',
      'support-staging': 'Staging',
      'support-production': 'Production',
    })
  )
  await openAgentsPage(page)
  await expect(page.locator(fleetAgentSelector('support'))).toContainText('Main')
  await startAgentChatFromFleet(page, 'support-staging')
  expect(
    await page.evaluate(() =>
      window.__identityControl.events
        .filter(event => event.action === 'create')
        .map(event => event.ref)
    )
  ).toEqual(['support-staging'])
})
