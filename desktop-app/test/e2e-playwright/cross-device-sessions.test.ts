// desktop-app/test/e2e-playwright/cross-device-sessions.test.ts
//
// Cross-device desktop sessions test suite (T1 / T2 / T3).
//
// Requires: running minikube + full stack + port-forwards + both seeded users.
// Run with:  npm run test:e2e:playwright
//
// ─── SELECTOR AUDIT ──────────────────────────────────────────────────────────
// The following data-testid attributes from the original spec were checked
// against the production UI source (desktop-app/ui/src/):
//
//   data-testid="chat-id"            → EXISTS  ChatListPanel.tsx (inside "View all" drawer)
//   data-testid="chat-remote-badge"  → EXISTS  ChatListPanel.tsx (when chat.remote === true)
//   data-testid="send-button"        → EXISTS  AgentsPage.tsx
//   data-testid="agent-response"     → EXISTS  AgentsPage.tsx  ← used here instead of "assistant-message"
//
// The following do NOT exist and have been replaced with fallback selectors:
//
//   data-testid="agent-selector"     → MISSING
//     Fallback: Resources > Agents + .agents-table-row-clickable row click
//               (or no-op when app auto-selects the only agent, as in chat.test.ts)
//     // TODO: add data-testid="agent-selector" in follow-up UI task
//
//   data-testid="new-chat-button"    → MISSING
//     Fallback: button:has-text("+ New thread")
//     // TODO: add data-testid="new-chat-button" in follow-up UI task
//
//   data-testid="message-input"      → MISSING (textarea has data-testid="chat-input")
//     Fallback: [data-testid="chat-input"]
//     // TODO: rename or add data-testid="message-input" alias in follow-up UI task
//
//   data-testid="assistant-message"  → MISSING (it is data-testid="agent-response")
//     Fallback: [data-testid="agent-response"]
//     // TODO: add data-testid="assistant-message" alias in follow-up UI task
//
import {
  HOST_REF,
  PROBE,
  USER_A_EMAIL,
  USER_B_EMAIL,
  enterAgentChat,
  openChatListPanel,
  waitForAssistantResponse,
} from './crossDeviceSessions.helpers.js'
import { expect, launchFreshElectron, loginAs, test, wipeChatsDir } from './fixtures.js'

// ─── suite ───────────────────────────────────────────────────────────────────

// State carries across tests within this describe block.
// mcp-host keeps the Conversation in memory;
// client-side state is wiped explicitly where the scenario requires.
test.describe.serial('cross-device desktop sessions', () => {
  let capturedChatId: string | null = null

  test.beforeAll(async () => {
    await wipeChatsDir()
  })

  // T1: User A creates a chat and sends a probe message.
  test('T1 — user A creates a chat and sends a probe message', async ({ appPage }) => {
    // appPage fixture auto-logs-in as USER_A_EMAIL — no explicit loginAs needed.
    await enterAgentChat(appPage)

    // Start a fresh thread.
    // TODO: add data-testid="new-chat-button" in follow-up UI task
    await appPage.getByRole('button', { name: /new thread/i }).click()
    await expect(appPage.locator('[data-testid="agent-response"]')).toHaveCount(0, {
      timeout: 10_000,
    })

    // Send the probe message.
    // TODO: rename or add data-testid="message-input" alias in follow-up UI task
    const chatInput = appPage.locator('[data-testid="chat-input"]')
    await chatInput.fill(PROBE)
    await appPage.locator('[data-testid="send-button"]').click()

    // Wait for the assistant to respond. Auto-approve any MCP approval prompts
    // (airtable-server asks for approval on memory-search; without approval
    // the task suspends and no response ever renders).
    // TODO: add data-testid="assistant-message" alias in follow-up UI task
    await waitForAssistantResponse(appPage, 0, 120_000)

    // Capture the chatId from the sidebar list panel.
    await openChatListPanel(appPage)
    const chatEl = appPage.locator('[data-testid="chat-id"]').first()
    capturedChatId = await chatEl.getAttribute('data-chat-id')
    expect(capturedChatId).toBeTruthy()

    const items = await appPage.locator('[data-testid="chat-id"]').count()
    expect(items).toBeGreaterThanOrEqual(1)

    // Close the panel.
    await appPage.keyboard.press('Escape')
  })

  // T2: User B on the same machine sees none of user A's chats.
  // IMPORTANT: do NOT call wipeChatsDir() here. User A's files remain on disk.
  // If per-user segmentation is broken, user B would see them.
  test("T2 — user B on the same machine sees none of user A's chats", async () => {
    const app = await launchFreshElectron()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginAs(page, USER_B_EMAIL)

    // TODO: add data-testid="agent-selector" in follow-up UI task
    await enterAgentChat(page)

    // Open the chat list panel to inspect [data-testid="chat-id"] rows.
    await openChatListPanel(page)

    // Note: the app auto-creates a fresh "New Chat" when a user first enters an
    // agent, so user B may have exactly 1 (their own, empty) chat. The invariant
    // that matters is that user A's specific chatId from T1 does NOT leak here.
    expect(capturedChatId, 'T1 must have captured a chatId').toBeTruthy()
    const matchingCount = await page.locator(`[data-chat-id="${capturedChatId}"]`).count()
    expect(matchingCount, `user A's chatId ${capturedChatId} leaked into user B's sidebar`).toBe(0)

    await app.close()
  })

  // T3: User A on a fresh install sees their chat restored from the server.
  test('T3 — user A on a fresh install sees their chat restored from the server', async () => {
    await wipeChatsDir()

    const app = await launchFreshElectron()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginAs(page, USER_A_EMAIL)

    // TODO: add data-testid="agent-selector" in follow-up UI task
    await enterAgentChat(page)

    // Open the chat list panel to find the remotely-restored chats.
    await openChatListPanel(page)

    // Wait for at least one chat row to appear (the catalog fetch completes
    // asynchronously after panel-open). This proves the remote-catalog fetch
    // and merge logic succeeded.
    const anyChat = page.locator('[data-testid="chat-id"]')
    try {
      await expect(anyChat.first()).toBeVisible({ timeout: 15_000 })
    } catch (err) {
      await page.screenshot({ path: 'test-results/t3-no-chats-rendered.png', fullPage: true })
      const html = await page
        .locator('.chat-list-panel')
        .innerHTML()
        .catch(() => '(panel not found)')
      console.error(
        `[T3] no chat rows rendered. panel innerHTML (first 500 chars):\n${html.slice(0, 500)}`
      )
      throw err
    }
    const rendered = await anyChat.count()
    console.log(`[T3] rendered ${rendered} chat rows`)

    // If T1 captured a chatId, verify it's present specifically.
    // Otherwise (T3 running standalone after a prior session), just verify the
    // remote catalog returned AT LEAST one chat with a remote badge.
    const targetChatId = capturedChatId ?? (await anyChat.first().getAttribute('data-chat-id'))
    expect(targetChatId, 'need a chatId to verify').toBeTruthy()

    const chatRow = page.locator(`[data-chat-id="${targetChatId!}"]`)
    await chatRow.scrollIntoViewIfNeeded()
    await expect(chatRow).toBeVisible({ timeout: 5_000 })

    const remoteBadge = chatRow.locator('[data-testid="chat-remote-badge"]')
    await expect(remoteBadge).toBeVisible({ timeout: 5_000 })

    // Click the chat row to hydrate transcript from server.
    // The panel closes itself after selection (onClose is called in ChatListPanel onClick).
    await chatRow.click()

    // After hydration, SOMETHING from the server transcript should appear.
    // If T1 produced a known probe string, check for that specifically;
    // otherwise, verify at least one user message renders.
    if (capturedChatId && capturedChatId === targetChatId) {
      await page.waitForSelector(`text=${PROBE}`, { timeout: 10_000 })
    } else {
      await expect(
        page.locator('[data-testid="user-message"], .user-message, .message-user').first()
      ).toBeVisible({ timeout: 10_000 })
    }

    // After clicking (hydrating), the remote badge should be gone for this chat.
    const badgeAfter = page.locator(
      `[data-chat-id="${targetChatId!}"] [data-testid="chat-remote-badge"]`
    )
    // Re-open panel to re-check badge state (panel closes on chat select).
    await openChatListPanel(page)
    await expect(badgeAfter).toBeHidden({ timeout: 5_000 })
    await page.keyboard.press('Escape')

    // Send a follow-up message on the restored chat.
    const chatInput = page.locator('[data-testid="chat-input"]')
    const responsesBefore = await page.locator('[data-testid="agent-response"]').count()
    await chatInput.fill('follow-up on existing chat')
    await page.locator('[data-testid="send-button"]').click()

    // Wait for the next agent response — auto-approve any MCP approval that
    // pops up. If this never fires, the follow-up didn't reach the server and
    // the test fails (no silent swallow).
    await waitForAssistantResponse(page, responsesBefore, 120_000)

    // Server-side verification: the same chatId should now have turnCount=2
    // (was 1 when T1 created it). Proves the follow-up appended to the SAME
    // server-side conversation, not a new one. Uses window.clerum.rpc.listSessions
    // via page.evaluate so we reuse the app's authenticated token.
    const serverTurnCount = await page.evaluate(
      async args => {
        const result = await (window as any).clerum.rpc.listSessions(args.hostRef)
        const entry = result?.items?.find((i: any) => i.chatId === args.chatId)
        return entry?.turnCount
      },
      { hostRef: HOST_REF, chatId: targetChatId! }
    )
    expect(serverTurnCount, 'follow-up should have appended to same server-side chat').toBe(2)

    await app.close()
  })

  test("T4 — user B fetching user A's transcript by chatId gets 404 (enumeration-defense)", async () => {
    // Requires T1 to have captured a chatId owned by user A.
    expect(capturedChatId, "T4 needs T1's captured chatId").toBeTruthy()

    const app = await launchFreshElectron()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginAs(page, USER_B_EMAIL)

    // Make sure the IPC bridge is loaded by entering the agent view.
    await enterAgentChat(page)

    // Call rpc.loadSessionMessages through the renderer's exposed bridge.
    // Direct URL attack: try to read user A's chat id as user B.
    // Expected: the rpc client throws the exact 404 contract.
    const result = await page.evaluate(
      async args => {
        try {
          await (window as any).clerum.rpc.loadSessionMessages(
            args.hostRef,
            args.agent,
            args.chatId
          )
          return { ok: true }
        } catch (e: any) {
          return { ok: false, message: e?.message ?? String(e) }
        }
      },
      { hostRef: HOST_REF, agent: HOST_REF, chatId: capturedChatId! }
    )

    expect(result.ok, "user B must NOT be able to read user A's transcript").toBe(false)
    // rpcProxyClient.loadSessionMessages throws this exact message only on 404; that
    // is the canonical body mcp-host emits for both "never existed" and
    // "belongs to another user" (enumeration-defense).
    expect(result.message).toBe('Session not found (404)')

    await app.close()
  })

  test('T5 — multiple remote chats hydrate independently; badges update per-chat', async () => {
    // Fresh install: forces all existing chats to appear as remote-only.
    await wipeChatsDir()

    const app = await launchFreshElectron()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginAs(page, USER_A_EMAIL)
    await enterAgentChat(page)
    await openChatListPanel(page)

    // Wait for the catalog fetch + merge to finish (at least one row in panel).
    await expect(page.locator('[data-testid="chat-id"]').first()).toBeVisible({
      timeout: 15_000,
    })

    const badgedRows = page.locator(
      '[data-testid="chat-id"]:has([data-testid="chat-remote-badge"])'
    )
    const badgedCount = await badgedRows.count()
    // This test requires at least 2 remote chats to be meaningful. Prior runs
    // populate the server-side store; if the test environment was just reset,
    // skip (not fail).
    test.skip(badgedCount < 2, `need >=2 remote chats in server catalog, saw ${badgedCount}`)

    // Capture the ids of TWO distinct badged chats up-front. We test the
    // per-chat invariant (this chatId's badge goes away when clicked) rather
    // than a global count, which can be thrown off by any independent state
    // mutation during the test.
    const firstChatId = await badgedRows.nth(0).getAttribute('data-chat-id')
    const secondChatId = await badgedRows.nth(1).getAttribute('data-chat-id')
    expect(firstChatId).toBeTruthy()
    expect(secondChatId).toBeTruthy()
    expect(firstChatId).not.toBe(secondChatId)

    // Pre-condition: both are badged.
    const firstBadge = page.locator(
      `[data-chat-id="${firstChatId}"] [data-testid="chat-remote-badge"]`
    )
    const secondBadge = page.locator(
      `[data-chat-id="${secondChatId}"] [data-testid="chat-remote-badge"]`
    )
    expect(await firstBadge.count()).toBe(1)
    expect(await secondBadge.count()).toBe(1)

    // Click the first chat. Panel closes after selection (onClose in onClick).
    // We target the exact row by data-chat-id, since the panel sort order may
    // change after hydration and .first() is not stable across re-renders.
    await page.locator(`[data-chat-id="${firstChatId}"]`).click()
    await page.locator('.chat-list-panel').waitFor({ state: 'hidden', timeout: 5_000 })

    // Re-open; first chat has NO badge, second still has its badge.
    await openChatListPanel(page)
    await expect(firstBadge).toHaveCount(0)
    await expect(secondBadge).toHaveCount(1)

    // Click the second chat.
    await page.locator(`[data-chat-id="${secondChatId}"]`).click()
    await page.locator('.chat-list-panel').waitFor({ state: 'hidden', timeout: 5_000 })

    // Re-open; BOTH hydrated chats are now badge-less. The per-chat invariant
    // holds even though other remote chats in the panel retain their badges.
    await openChatListPanel(page)
    await expect(firstBadge).toHaveCount(0)
    await expect(secondBadge).toHaveCount(0)

    await app.close()
  })
})
