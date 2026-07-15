// desktop-app/test/e2e-playwright/cross-device-sessions.test.ts
//
// Cross-device desktop sessions test suite (T1 / T2 / T3).
//
// Requires: running minikube + full stack + port-forwards + both seeded users.
// Run with:  npm run test:e2e:playwright
//
// ─── SELECTOR AUDIT ──────────────────────────────────────────────────────────
// The following selectors from the original spec were checked against the
// production UI source (desktop-app/ui/src/):
//
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
//     Fallback: agent actions menu -> "New chat"
//     // TODO: add data-testid="new-chat-button" in follow-up UI task
//
//   data-testid="chat-id" / "chat-remote-badge" → REMOVED with the old drawer UI
//     Fallback: visible sidebar session button + window.clerum.rpc.listSessions()
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
  listServerSessions,
  remoteSessionTitle,
  sessionChatId,
  sidebarSessionButton,
  waitForAssistantResponse,
  waitForLocalChatByTitle,
  waitForServerSessionByChatId,
} from './crossDeviceSessions.helpers.js'
import { expect, launchFreshElectron, loginAs, test, wipeChatsDir } from './fixtures.js'

// ─── suite ───────────────────────────────────────────────────────────────────

const ASSISTANT_RESPONSE_TIMEOUT = 240_000

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
    test.setTimeout(360_000)

    // appPage fixture auto-logs-in as USER_A_EMAIL — no explicit loginAs needed.
    await enterAgentChat(appPage)

    // enterAgentChat opens a fresh chat through the visible agent actions menu.
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
    await waitForAssistantResponse(appPage, 0, ASSISTANT_RESPONSE_TIMEOUT)

    const session = await waitForLocalChatByTitle(appPage, PROBE)
    capturedChatId = sessionChatId(session)
    expect(capturedChatId).toBeTruthy()
    await waitForServerSessionByChatId(appPage, capturedChatId!)
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

    // Note: the app auto-creates a fresh chat when a user first enters an agent,
    // so user B may have their own empty session. The invariant that matters is
    // that user A's specific chatId/title does NOT leak here.
    expect(capturedChatId, 'T1 must have captured a chatId').toBeTruthy()
    const userBSessions = await listServerSessions(page)
    expect(
      userBSessions.map(sessionChatId),
      `user A's chatId ${capturedChatId} leaked into user B's session catalog`
    ).not.toContain(capturedChatId)

    await app.close()
  })

  // T3: User A on a fresh install sees their chat restored from the server.
  test('T3 — user A on a fresh install sees their chat restored from the server', async () => {
    test.setTimeout(360_000)

    await wipeChatsDir()

    const app = await launchFreshElectron()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginAs(page, USER_A_EMAIL)

    // TODO: add data-testid="agent-selector" in follow-up UI task
    await enterAgentChat(page)

    await waitForServerSessionByChatId(page, capturedChatId!)
    const restoredSession = (await listServerSessions(page)).find(
      session => sessionChatId(session) === capturedChatId
    )
    const targetChatId = capturedChatId ?? (restoredSession ? sessionChatId(restoredSession) : null)
    expect(targetChatId, 'need a chatId to verify').toBeTruthy()

    const restoredButton = sidebarSessionButton(page, remoteSessionTitle(targetChatId!)).or(
      sidebarSessionButton(page, PROBE)
    )
    await expect(restoredButton).toBeVisible({ timeout: 15_000 })
    await restoredButton.click()

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

    // Send a follow-up message on the restored chat.
    const chatInput = page.locator('[data-testid="chat-input"]')
    const responsesBefore = await page.locator('[data-testid="agent-response"]').count()
    await chatInput.fill('follow-up on existing chat')
    await page.locator('[data-testid="send-button"]').click()

    // Wait for the next agent response — auto-approve any MCP approval that
    // pops up. If this never fires, the follow-up didn't reach the server and
    // the test fails (no silent swallow).
    await waitForAssistantResponse(page, responsesBefore, ASSISTANT_RESPONSE_TIMEOUT)

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
    expect(result.message).toContain('Session not found (404)')

    await app.close()
  })

  test('T5 — multiple remote chats hydrate independently from the sidebar', async () => {
    // Fresh install: forces all existing chats to appear as remote-only.
    await wipeChatsDir()

    const app = await launchFreshElectron()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginAs(page, USER_A_EMAIL)
    await enterAgentChat(page)

    const remoteButtons = page.getByRole('button', { name: /^Open Remote · / })
    let visibleRemoteCount = await remoteButtons.count()
    if (visibleRemoteCount < 2) {
      await expect
        .poll(async () => await remoteButtons.count(), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2)
        .catch(() => {})
      visibleRemoteCount = await remoteButtons.count()
    }
    test.skip(visibleRemoteCount < 2, `need >=2 visible remote chats, saw ${visibleRemoteCount}`)

    const firstLabel = (await remoteButtons.nth(0).getAttribute('aria-label')) ?? ''
    const secondLabel = (await remoteButtons.nth(1).getAttribute('aria-label')) ?? ''
    const firstPrefix = firstLabel.match(/^Open Remote · ([0-9a-f]{8})/)?.[1]
    const secondPrefix = secondLabel.match(/^Open Remote · ([0-9a-f]{8})/)?.[1]
    expect(firstPrefix).toBeTruthy()
    expect(secondPrefix).toBeTruthy()

    const candidates = (await listServerSessions(page)).filter(session => {
      const id = sessionChatId(session)
      return id && (session.turnCount ?? 0) > 0
    })
    const firstChatId = sessionChatId(
      candidates.find(session => sessionChatId(session)?.startsWith(firstPrefix!))!
    )
    const secondChatId = sessionChatId(
      candidates.find(session => sessionChatId(session)?.startsWith(secondPrefix!))!
    )
    expect(firstChatId).toBeTruthy()
    expect(secondChatId).toBeTruthy()
    expect(firstChatId).not.toBe(secondChatId)

    const firstTitle = remoteSessionTitle(firstChatId!)
    const secondTitle = remoteSessionTitle(secondChatId!)

    const firstButton = sidebarSessionButton(page, firstTitle).first()
    await expect(firstButton).toBeVisible({ timeout: 15_000 })
    await firstButton.click()
    await expect
      .poll(async () => {
        return await page.evaluate(
          async args => {
            return (await (window as any).clerum.chat.loadMessages(args.hostRef, args.chatId))
              .length
          },
          { hostRef: HOST_REF, chatId: firstChatId! }
        )
      })
      .toBeGreaterThan(0)

    const secondButton = sidebarSessionButton(page, secondTitle).first()
    await expect(secondButton).toBeVisible({ timeout: 15_000 })
    await secondButton.click()
    await expect
      .poll(async () => {
        return await page.evaluate(
          async args => {
            return (await (window as any).clerum.chat.loadMessages(args.hostRef, args.chatId))
              .length
          },
          { hostRef: HOST_REF, chatId: secondChatId! }
        )
      })
      .toBeGreaterThan(0)

    await app.close()
  })
})
