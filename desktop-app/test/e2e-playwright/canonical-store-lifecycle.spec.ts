/// <reference path="../../src/renderer.d.ts" />
// E2E_GUARDIAN_IPC_FLOW: real Desktop RPC uses main-process IPC. Visible
// transitions, persisted business IDs, and a read-only full catalog are the
// signals; neither storage mutation nor a core network mock advances this flow.
import { expect, test } from '@playwright/test'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acknowledgeCheckpoint,
  captureCatalog,
  closeJourney,
  createChatVisibly,
  launchJourney,
  observedChats,
  renameChatVisibly,
  reopenChatVisibly,
  repoRoot,
  required,
  sendTurnVisibly,
  signInVisibly,
  verifyJourneyInputs,
  waitCheckpoint,
} from './canonicalStoreJourney'
import { openAgentsPage } from './navigationHelpers'

const checkpointPhases = [
  'pre-authority-McpServer',
  'pre-authority-Context',
  'canonical-activated',
  'stateless-false',
  'stateless-true',
  'channel-added',
  'channel-removed',
  'canonical-hold-1',
  'canonical-hold-2',
  'slow-writer-restarted',
]
test.beforeAll(() => verifyJourneyInputs())

async function newNamedConversation(
  page: import('@playwright/test').Page,
  marker: string,
  title: string
) {
  const host = required('E2E_CANONICAL_HOST_REF')
  const before = new Set((await observedChats(page, host)).map(chat => chat.id))
  await createChatVisibly(page, required('E2E_CANONICAL_HOST_DISPLAY'))
  const messageIds = await sendTurnVisibly(page, marker)
  await expect
    .poll(async () => (await observedChats(page, host)).filter(chat => !before.has(chat.id)), {
      timeout: 30000,
    })
    .toHaveLength(1)
  const produced = (await observedChats(page, host)).filter(chat => !before.has(chat.id))
  expect(produced).toHaveLength(1)
  const conversation = produced[0]!
  expect(conversation.id).toMatch(/\S+/)
  await renameChatVisibly(page, conversation.title, title)
  await expect
    .poll(
      async () => (await observedChats(page, host)).find(chat => chat.id === conversation.id)?.title
    )
    .toBe(title)
  return { chatId: conversation.id, messageIds }
}
async function stoppedGate(gate: ChildProcess): Promise<void> {
  if (gate.exitCode !== null || gate.signalCode !== null) return
  const exited = once(gate, 'exit')
  gate.kill('SIGTERM')
  const timer = setTimeout(() => gate.kill('SIGKILL'), 300000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

test('visible chat before activation survives confirmed modes, live holds and writer restart', async ({}, testInfo) => {
  const runId = required('E2E_CANONICAL_RUN_ID')
  const title = `Canonical continuity ${runId}`
  const markers = [`canonical-ui-before-${runId}`]
  let desktop = await launchJourney(testInfo)
  let gate: ChildProcess | undefined
  let gateError: Error | undefined
  const barrier = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical825-barrier-'))
  fs.chmodSync(barrier, 0o700)
  fs.writeFileSync(path.join(barrier, 'binding.json'), JSON.stringify({ runId }), {
    mode: 0o600,
    flag: 'wx',
  })
  const receipts: unknown[] = []
  try {
    await test.step('enter by visible login and create a genuine legacy-floor conversation', async () => {
      const floor = await captureCatalog()
      expect(floor.identity).toBeNull()
      await signInVisibly(desktop.page)
      const produced = await newNamedConversation(desktop.page, markers[0]!, title)
      receipts.push({
        stage: 'before-canonical-opt-in',
        chatId: produced.chatId,
        ...produced.messageIds,
      })
      await expect
        .poll(async () => (await captureCatalog()).counts.messages, { timeout: 120000 })
        .toBeGreaterThan(floor.counts.messages!)
    })
    await test.step('start the owned runtime operation only after the UI message was accepted', async () => {
      gate = spawn(
        'bash',
        [path.join(repoRoot, 'scripts/e2e/e2e-hcc-canonical-store-lifecycle.sh')],
        {
          cwd: repoRoot,
          env: { ...process.env, E2E_CANONICAL_UI_BARRIER_DIR: barrier },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      gate.once('error', error => {
        gateError = error
      })
      // The runtime script emits only sanitized status/UID/hash evidence.
      gate.stdout?.on('data', () => undefined)
      gate.stderr?.on('data', () => undefined)
    })
    for (let index = 0; index < checkpointPhases.length; index++) {
      const checkpoint = await waitCheckpoint(barrier, index + 1, runId, gate!)
      expect(checkpoint.phase).toBe(checkpointPhases[index])
      await test.step(`reopen the same chat through visible navigation: ${checkpoint.phase}`, async () => {
        const before = await captureCatalog()
        await reopenChatVisibly(
          desktop.page,
          title,
          required('E2E_CANONICAL_HOST_DISPLAY'),
          markers
        )
        const afterReopen = await captureCatalog()
        expect(afterReopen.ids).toEqual(before.ids)
        expect(afterReopen.rowHashes).toEqual(before.rowHashes)
        if (checkpoint.kind !== 'hold') {
          expect(afterReopen.identity?.storeId).toBe(checkpoint.runtime.storeId)
          const marker = `canonical-ui-${checkpoint.sequence}-${runId}`
          const messages = await sendTurnVisibly(desktop.page, marker)
          markers.push(marker)
          await expect
            .poll(async () => (await captureCatalog()).counts.messages, { timeout: 120000 })
            .toBeGreaterThan(before.counts.messages!)
          const after = await captureCatalog()
          for (const id of before.ids.messages) expect(after.ids.messages).toContain(id)
          expect(after.identity?.storeId).toBe(before.identity?.storeId)
          receipts.push({ stage: checkpoint.phase, ...messages, storeId: after.identity?.storeId })
        } else {
          expect(afterReopen.catalogHash).toBe(before.catalogHash)
          expect(afterReopen.identity).toEqual(before.identity)
          receipts.push({ stage: checkpoint.phase, kind: 'verified-live-hold' })
        }
        acknowledgeCheckpoint(barrier, checkpoint)
      })
    }
    await test.step('require successful runtime operation exit and rebuild UI state from a fresh client', async () => {
      const exit =
        gate!.exitCode === null && gate!.signalCode === null
          ? (await once(gate!, 'exit'))[0]
          : gate!.exitCode
      expect(gateError).toBeUndefined()
      expect(exit).toBe(0)
      const durable = await captureCatalog()
      await closeJourney(desktop)
      desktop = await launchJourney(testInfo)
      await signInVisibly(desktop.page)
      await reopenChatVisibly(desktop.page, title, required('E2E_CANONICAL_HOST_DISPLAY'), markers)
      const reopened = await captureCatalog()
      expect(reopened.catalogHash).toBe(durable.catalogHash)
      expect(reopened.ids).toEqual(durable.ids)
      const marker = `canonical-ui-fresh-client-${runId}`
      await sendTurnVisibly(desktop.page, marker)
      await expect
        .poll(async () => (await captureCatalog()).counts.messages, { timeout: 120000 })
        .toBeGreaterThan(durable.counts.messages!)
      expect((await captureCatalog()).identity?.storeId).toBe(durable.identity?.storeId)
    })
  } finally {
    if (gate) await stoppedGate(gate)
    await closeJourney(desktop)
    fs.rmSync(barrier, { recursive: true, force: true })
    await testInfo.attach('canonical-store-ui-business-receipts', {
      body: JSON.stringify({
        runId,
        hostRef: required('E2E_CANONICAL_HOST_REF'),
        evidenceLane: 'electron-ui-and-runtime',
        hostDimension: 'linux-no-sfs',
        desktopS6Host: 'SEPARATE_UNPROVEN_GATE',
        receipts,
      }),
      contentType: 'application/json',
    })
  }
})

test('fault witness: missing intermediate fleet makes the visible journey fail', async ({}, testInfo) => {
  const desktop = await launchJourney(testInfo)
  try {
    await signInVisibly(desktop.page)
    await newNamedConversation(
      desktop.page,
      `intermediate-control-${randomUUID()}`,
      `Intermediate control ${randomUUID()}`
    )
    await openAgentsPage(desktop.page)
    await expect(
      desktop.page.getByRole('button', {
        name: `More actions for ${required('E2E_CANONICAL_HOST_DISPLAY')}`,
        exact: true,
      })
    ).toBeVisible()
    // Explicit negative UI mutation, isolated to this client. No product/API mock.
    await desktop.page.evaluate(() => document.body.replaceChildren())
    await expect(desktop.page.locator('body')).toBeEmpty()
    await expect(
      createChatVisibly(desktop.page, required('E2E_CANONICAL_HOST_DISPLAY'), 3000)
    ).rejects.toThrow()
  } finally {
    await closeJourney(desktop)
  }
})

test('fault witness: a visible submit button that does nothing cannot pass', async ({}, testInfo) => {
  const desktop = await launchJourney(testInfo)
  const marker = `submit-noop-${randomUUID()}`
  try {
    await signInVisibly(desktop.page)
    await createChatVisibly(desktop.page, required('E2E_CANONICAL_HOST_DISPLAY'))
    const before = await captureCatalog()
    // Explicit negative event mutation on the real button, not an API shortcut.
    await desktop.page.getByTestId('send-button').evaluate(button =>
      button.addEventListener(
        'click',
        event => {
          event.preventDefault()
          event.stopImmediatePropagation()
          button.setAttribute('data-e2e-click-suppressed', 'true')
        },
        true
      )
    )
    await expect(sendTurnVisibly(desktop.page, marker, 3000)).rejects.toThrow()
    await expect(desktop.page.getByTestId('send-button')).toHaveAttribute(
      'data-e2e-click-suppressed',
      'true'
    )
    await expect(desktop.page.getByRole('textbox', { name: 'Agent message composer' })).toHaveValue(
      `Reply with exactly ${marker}.`
    )
    expect((await captureCatalog()).catalogHash).toBe(before.catalogHash)
  } finally {
    await closeJourney(desktop)
  }
})

test('fault witness: accepted backend writes with a hidden transcript still fail UI transition', async ({}, testInfo) => {
  const desktop = await launchJourney(testInfo)
  const marker = `accepted-no-ui-${randomUUID()}`
  try {
    await signInVisibly(desktop.page)
    await newNamedConversation(
      desktop.page,
      `render-control-${randomUUID()}`,
      `Render control ${randomUUID()}`
    )
    const before = await captureCatalog()
    // Explicit negative rendering mutation. The click and real backend execute.
    await desktop.page.addStyleTag({
      content: '[data-testid="agent-response"] { visibility: hidden !important; }',
    })
    await expect(sendTurnVisibly(desktop.page, marker, 5000)).rejects.toThrow()
    await expect
      .poll(async () => (await captureCatalog()).counts.messages, { timeout: 120000 })
      .toBeGreaterThan(before.counts.messages! + 1)
    const persisted = await captureCatalog()
    for (const id of before.ids.messages) expect(persisted.ids.messages).toContain(id)
    await expect(
      desktop.page.getByTestId('agent-response').filter({ hasText: marker })
    ).toBeHidden()
    expect(persisted.catalogHash).not.toBe(before.catalogHash)
  } finally {
    await closeJourney(desktop)
  }
})

test('fault witness: direct unauthenticated conversation route is rejected with authorized UI control', async ({
  browser,
}, testInfo) => {
  const desktop = await launchJourney(testInfo)
  const anonymous = await browser.newContext()
  const marker = `direct-guard-${randomUUID()}`
  try {
    await signInVisibly(desktop.page)
    const produced = await newNamedConversation(
      desktop.page,
      marker,
      `Guard control ${randomUUID()}`
    )
    const before = await captureCatalog()
    const guardPage = await anonymous.newPage()
    const url = `${required('RPC_PROXY_BASE_URL').replace(/\/$/, '')}/api/v1/rpc/hosts/${required('E2E_CANONICAL_HOST_REF')}/sessions/${required('E2E_CANONICAL_HOST_REF')}/${produced.chatId}/messages`
    // Negative protected terminal-route guard; happy-path creation was visible.
    const response = await guardPage.goto(url)
    expect(response).not.toBeNull()
    expect([401, 403]).toContain(response!.status())
    await expect(guardPage).toHaveURL(url)
    await expect(guardPage.locator('body')).toContainText(/unauthorized|forbidden/i)
    await expect(guardPage.locator('body')).not.toContainText(marker)
    await expect(guardPage.locator('body')).not.toContainText(produced.chatId)
    expect((await captureCatalog()).catalogHash).toBe(before.catalogHash)
    await expect(
      desktop.page.getByTestId('agent-response').filter({ hasText: marker })
    ).toBeVisible()
  } finally {
    await anonymous.close()
    await closeJourney(desktop)
  }
})
