import { type ElectronApplication, type Page, type TestInfo, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  requireRecorderConfirm,
} from './qa-recorder-helpers'
import {
  profilesSql,
  sqlLiteral,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'

const RUN_ENABLED = process.env.E2E_PLUGIN_SDK_DESKTOP === '1'
const APP_TITLE = process.env.E2E_PLUGIN_SDK_APP_TITLE || 'Prompt & Notify'
const RECIPE_NAME = process.env.E2E_PLUGIN_SDK_RECIPE_NAME || 'evenfire-prompt-notify-app'
const RECIPE_NAMESPACE = process.env.E2E_PLUGIN_SDK_RECIPE_NAMESPACE || 'sandbox-recipes'
const CAPTURE_VISUALS = process.env.E2E_PLUGIN_SDK_CAPTURE === '1'

test.skip(
  !RUN_ENABLED,
  'Set E2E_PLUGIN_SDK_DESKTOP=1 for the branch-owned Electron/Apps/WebContentsView gate.'
)

type EmbeddedContents = { id: number; url: string }
type Rect = { x: number; y: number; width: number; height: number }
type EmbeddedOption = { value: string; label: string }
type NativeLayout = {
  windowBounds: Rect
  viewBounds: Rect | null
  displayScaleFactor: number
  mainRendererDpr: number
  embeddedRendererDpr: number | null
  embeddedCaptureSize: { width: number; height: number } | null
}

function assertSteplessSdkRecipePrecondition(): void {
  const context =
    process.env.E2E_K8S_CONTEXT || process.env.KUBECONTEXT || process.env.K8S_CONTEXT || ''
  if (!context) throw new Error('E2E_K8S_CONTEXT is required for the stepless recipe precondition.')
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(RECIPE_NAME)) {
    throw new Error(`Unsafe E2E_PLUGIN_SDK_RECIPE_NAME: ${RECIPE_NAME}`)
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(RECIPE_NAMESPACE)) {
    throw new Error(`Unsafe E2E_PLUGIN_SDK_RECIPE_NAMESPACE: ${RECIPE_NAMESPACE}`)
  }
  const raw = execFileSync(
    'kubectl',
    [
      '--context',
      context,
      '-n',
      RECIPE_NAMESPACE,
      'get',
      'workflowrecipe',
      RECIPE_NAME,
      '-o',
      'json',
    ],
    { encoding: 'utf8', timeout: 30_000 }
  )
  const recipe = JSON.parse(raw) as {
    spec?: {
      steps?: unknown
      triggers?: unknown
      agent?: { provider?: unknown; model?: unknown }
      workloads?: unknown
      pluginWorkloadSdk?: { promptBridge?: Record<string, unknown> }
    }
  }
  const spec = recipe.spec ?? {}
  if (spec.steps !== undefined || spec.triggers !== undefined) {
    throw new Error(
      'Desktop candidate must be SDK-only: spec.steps and spec.triggers must be absent.'
    )
  }
  if (
    typeof spec.agent?.provider !== 'string' ||
    !spec.agent.provider ||
    typeof spec.agent.model !== 'string' ||
    !spec.agent.model
  ) {
    throw new Error('Desktop candidate must declare a resolvable spec.agent bootstrap.')
  }
  if (!['openai', 'claude'].includes(spec.agent.provider.toLowerCase())) {
    throw new Error(
      `Desktop T3 candidate must use OpenAI or Claude; received provider ${spec.agent.provider}.`
    )
  }
  if (!Array.isArray(spec.workloads) || spec.workloads.length === 0) {
    throw new Error('Desktop candidate must declare at least one plugin workload.')
  }
  if (
    typeof spec.pluginWorkloadSdk?.promptBridge !== 'object' ||
    spec.pluginWorkloadSdk.promptBridge === null
  ) {
    throw new Error('Desktop candidate must declare the pluginWorkloadSdk.promptBridge object.')
  }
}

async function findPromptNotifyContents(
  app: ElectronApplication
): Promise<EmbeddedContents | null> {
  return app.evaluate(async ({ webContents }, expectedTitle) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue
      const url = contents.getURL()
      if (!url.includes('/api/v1/sandbox-ui/') || !url.includes('/view/')) continue
      const title = await contents.executeJavaScript('document.title').catch(() => '')
      if (title === expectedTitle) return { id: contents.id, url }
    }
    return null
  }, APP_TITLE)
}

async function embeddedRect(
  app: ElectronApplication,
  webContentsId: number,
  selector: string
): Promise<Rect | null> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.webContentsId)
      if (!contents || contents.isDestroyed()) return null
      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(args.selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`
      return contents.executeJavaScript(script)
    },
    { webContentsId, selector }
  )
}

async function embeddedText(
  app: ElectronApplication,
  webContentsId: number,
  selector: string
): Promise<string> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.webContentsId)
      if (!contents || contents.isDestroyed()) return ''
      const script = `document.querySelector(${JSON.stringify(args.selector)})?.textContent ?? ''`
      return String(await contents.executeJavaScript(script))
    },
    { webContentsId, selector }
  )
}

async function embeddedValue(
  app: ElectronApplication,
  webContentsId: number,
  selector: string
): Promise<string> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.webContentsId)
      if (!contents || contents.isDestroyed()) return ''
      const script = `String(document.querySelector(${JSON.stringify(args.selector)})?.value ?? '')`
      return String(await contents.executeJavaScript(script))
    },
    { webContentsId, selector }
  )
}

async function embeddedOptions(
  app: ElectronApplication,
  webContentsId: number,
  selector: string
): Promise<EmbeddedOption[]> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.webContentsId)
      if (!contents || contents.isDestroyed()) return []
      const script = `Array.from(document.querySelector(${JSON.stringify(args.selector)})?.options ?? []).map((option) => ({ value: option.value, label: option.textContent ?? '' }))`
      return (await contents.executeJavaScript(script)) as EmbeddedOption[]
    },
    { webContentsId, selector }
  )
}

async function embeddedActiveControl(
  app: ElectronApplication,
  webContentsId: number,
  selector: string
): Promise<boolean> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.webContentsId)
      if (!contents || contents.isDestroyed()) return false
      const script = `document.activeElement?.matches(${JSON.stringify(args.selector)}) === true`
      return Boolean(await contents.executeJavaScript(script))
    },
    { webContentsId, selector }
  )
}

async function embeddedActiveSignature(
  app: ElectronApplication,
  webContentsId: number
): Promise<string> {
  return app.evaluate(async ({ webContents }, webContentsId) => {
    const contents = webContents.fromId(webContentsId)
    if (!contents || contents.isDestroyed()) return 'destroyed'
    return String(
      await contents.executeJavaScript(`(() => {
          const el = document.activeElement;
          if (!el) return 'none';
          return [el.tagName, el.id || '', el.getAttribute('name') || ''].join('#');
        })()`)
    )
  }, webContentsId)
}

/**
 * Capture the actual native WebContentsView, which is composited above the
 * renderer and therefore is not guaranteed to appear in page.screenshot().
 * The data URL crosses the Electron boundary without exposing browser state
 * or using a DOM shortcut; the resulting PNG is a Playwright test artifact.
 */
async function captureEmbeddedView(
  app: ElectronApplication,
  webContentsId: number,
  outputPath: string
): Promise<void> {
  const dataUrl = await app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id)
    if (!contents || contents.isDestroyed()) throw new Error('Embedded WebContentsView closed')
    const image = await contents.capturePage()
    return image.toDataURL()
  }, webContentsId)
  const encoded = dataUrl.match(/^data:image\/png;base64,(.+)$/)?.[1]
  if (!encoded) throw new Error('Electron returned a non-PNG sandbox UI capture')
  writeFileSync(outputPath, Buffer.from(encoded, 'base64'))
}

/** Capture the BrowserWindow renderer surface for comparison with the native child capture. */
async function captureDesktopWindow(app: ElectronApplication, outputPath: string): Promise<void> {
  const dataUrl = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) throw new Error('Desktop BrowserWindow closed')
    const image = await window.capturePage()
    return image.toDataURL()
  })
  const encoded = dataUrl.match(/^data:image\/png;base64,(.+)$/)?.[1]
  if (!encoded) throw new Error('Electron returned a non-PNG desktop window capture')
  writeFileSync(outputPath, Buffer.from(encoded, 'base64'))
}

/** Read the native child-view bounds for a geometry comparison artifact. */
async function nativeEmbeddedLayout(
  app: ElectronApplication,
  webContentsId: number
): Promise<NativeLayout> {
  return app.evaluate(async ({ BrowserWindow, screen }, id) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) throw new Error('Desktop BrowserWindow closed')
    const child = window.contentView.children.find(view => view.webContents?.id === id)
    const windowBounds = window.getBounds()
    const display = screen.getDisplayMatching(windowBounds)
    const mainRendererDpr = Number(
      await window.webContents.executeJavaScript('window.devicePixelRatio')
    )
    const embeddedRendererDpr = child
      ? Number(await child.webContents.executeJavaScript('window.devicePixelRatio'))
      : null
    const embeddedCaptureSize = child ? (await child.webContents.capturePage()).getSize() : null
    return {
      windowBounds,
      viewBounds: child?.getBounds() ?? null,
      displayScaleFactor: display.scaleFactor,
      mainRendererDpr,
      embeddedRendererDpr,
      embeddedCaptureSize,
    }
  }, webContentsId)
}

async function attachVisualLayout(
  page: Page,
  app: ElectronApplication,
  webContentsId: number,
  testInfo: TestInfo,
  stage: string
): Promise<void> {
  const rendererRect = await page.locator('.sandbox-ui-embed-slot').boundingBox()
  const nativeLayout = await nativeEmbeddedLayout(app, webContentsId)
  await testInfo.attach(`sandbox-ui-layout-${stage}`, {
    body: JSON.stringify({ stage, rendererRect, nativeLayout }, null, 2),
    contentType: 'application/json',
  })
  console.log(`[sandbox-ui-visual] ${JSON.stringify({ stage, rendererRect, nativeLayout })}`)
}

async function sendEmbeddedKey(
  app: ElectronApplication,
  webContentsId: number,
  keyCode: string
): Promise<void> {
  await app.evaluate(
    ({ webContents }, args) => {
      const contents = webContents.fromId(args.webContentsId)
      if (!contents || contents.isDestroyed()) throw new Error('Embedded WebContentsView closed')
      contents.focus()
      contents.sendInputEvent({ type: 'keyDown', keyCode: args.keyCode })
      if (args.keyCode === 'Enter') {
        contents.sendInputEvent({ type: 'char', keyCode: '\r' })
      }
      contents.sendInputEvent({ type: 'keyUp', keyCode: args.keyCode })
    },
    { webContentsId, keyCode }
  )
}

async function focusEmbeddedControl(
  app: ElectronApplication,
  webContentsId: number,
  selector: string
): Promise<void> {
  // WebContentsView controls below the fold cannot be clicked with coordinates
  // returned by getBoundingClientRect(): Chromium drops pointer events whose
  // target point is outside the view. Tab traversal is the native keyboard
  // path a user takes and scrolls each focused control into view without DOM
  // focus()/scrollIntoView() shortcuts.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await embeddedActiveControl(app, webContentsId, selector)) return
    const activeBefore = await embeddedActiveSignature(app, webContentsId)
    await sendEmbeddedKey(app, webContentsId, 'Tab')
    await expect
      .poll(() => embeddedActiveSignature(app, webContentsId), {
        timeout: 2_000,
        intervals: [10, 25, 50],
      })
      .not.toBe(activeBefore)
  }
  throw new Error(`Embedded control ${selector} did not receive native keyboard focus.`)
}

async function typeEmbedded(
  app: ElectronApplication,
  webContentsId: number,
  selector: string,
  value: string
): Promise<void> {
  await focusEmbeddedControl(app, webContentsId, selector)
  await app.evaluate(
    ({ webContents }, args) => {
      const contents = webContents.fromId(args.webContentsId)
      if (!contents || contents.isDestroyed()) throw new Error('Embedded WebContentsView closed')
      contents.focus()
      for (const character of args.value) {
        contents.sendInputEvent({ type: 'char', keyCode: character })
      }
    },
    { webContentsId, value }
  )
  await expect.poll(() => embeddedValue(app, webContentsId, selector)).toBe(value)
}

async function activateEmbedded(
  app: ElectronApplication,
  webContentsId: number,
  selector: string
): Promise<void> {
  await focusEmbeddedControl(app, webContentsId, selector)
  await sendEmbeddedKey(app, webContentsId, 'Enter')
}

async function selectEmbeddedRecipient(
  app: ElectronApplication,
  webContentsId: number,
  selector: string,
  expectedEmail: string
): Promise<EmbeddedOption> {
  const options = await embeddedOptions(app, webContentsId, selector)
  const normalizedExpectedEmail = expectedEmail.trim().toLowerCase()
  const recipient = options.find(
    option => option.value && option.label.trim().toLowerCase() === normalizedExpectedEmail
  )
  if (!recipient) {
    throw new Error(
      `Embedded recipient picker ${selector} has no option for authenticated user ${expectedEmail}.`
    )
  }
  const recipientIndex = options.findIndex(option => option.value === recipient.value)
  if (recipientIndex < 0) {
    throw new Error(`Embedded recipient picker ${selector} lost the authenticated-user option.`)
  }

  // This is the native select path a user takes: focus the control, move from
  // the first option to the authenticated user's granted recipient, and commit
  // with Enter. The option order is not part of the contract, so the number of
  // ArrowDown events is derived from the live option list rather than assumed.
  // We inspect the option label only to verify the UI displays a human handle;
  // the value is never injected into the DOM or sent directly to the backend.
  await focusEmbeddedControl(app, webContentsId, selector)
  await sendEmbeddedKey(app, webContentsId, 'Home')
  for (let index = 0; index < recipientIndex; index += 1) {
    await sendEmbeddedKey(app, webContentsId, 'ArrowDown')
  }
  await sendEmbeddedKey(app, webContentsId, 'Enter')
  await expect.poll(() => embeddedValue(app, webContentsId, selector)).toBe(recipient.value)
  expect(recipient.label.trim().toLowerCase()).toBe(normalizedExpectedEmail)
  expect(recipient.label).not.toMatch(/^[0-9a-f-]{36}$/i)
  return recipient
}

function sdkInvocationCount(method: 'promptBridge' | 'clientNotifications'): number {
  const raw = profilesSql(`
    SELECT count(*)::int
      FROM plugin_workload_sdk_invocations
     WHERE recipe_namespace = ${sqlLiteral(RECIPE_NAMESPACE)}
       AND recipe_name = ${sqlLiteral(RECIPE_NAME)}
       AND method = ${sqlLiteral(method)};
  `)
  return Number.parseInt(raw, 10) || 0
}

function latestSdkInvocationStatus(method: 'promptBridge' | 'clientNotifications'): string {
  return profilesSql(`
    SELECT status
      FROM plugin_workload_sdk_invocations
     WHERE recipe_namespace = ${sqlLiteral(RECIPE_NAMESPACE)}
       AND recipe_name = ${sqlLiteral(RECIPE_NAME)}
       AND method = ${sqlLiteral(method)}
     ORDER BY created_at DESC
     LIMIT 1;
  `)
}

function notificationDeliverySignal(notificationId: string): string {
  return profilesSql(`
    SELECT event_type || '|' || status
      FROM notification_deliveries
     WHERE event_type = 'plugin_workload_sdk.notification'
       AND payload->>'notificationId' = ${sqlLiteral(notificationId)}
     LIMIT 1;
  `)
}

test('Desktop Apps executes promptBridge and clientNotifications inside the real WebContentsView', async ({}, testInfo) => {
  requireRecorderConfirm(
    'E2E_PLUGIN_SDK_WRITE_CONFIRM',
    'This journey performs one paid promptBridge call and sends one test notification.'
  )
  assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)
  // Read-only setup assertion. Every functional action that follows is through
  // the real Desktop UI and its native WebContentsView.
  assertSteplessSdkRecipePrecondition()

  let app: ElectronApplication | undefined
  let page: Page | undefined
  try {
    const credentials = desktopCredentials()
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page
    await login(page, credentials)

    await page.getByTestId('nav-sandbox-ui').click()
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
    const appCard = page.getByRole('button', { name: `Open ${APP_TITLE}`, exact: true })
    await expect(appCard).toBeVisible({ timeout: 30_000 })
    await appCard.click()
    await expect(page.getByRole('button', { name: 'Back to apps' })).toBeVisible({
      timeout: 30_000,
    })

    let embedded: EmbeddedContents | null = null
    await expect
      .poll(async () => {
        embedded = await findPromptNotifyContents(app!)
        return embedded?.url ?? ''
      })
      .toContain(
        `/api/v1/sandbox-ui/${encodeURIComponent(RECIPE_NAMESPACE)}/${encodeURIComponent(RECIPE_NAME)}/view/`
      )
    const webContentsId = embedded!.id
    await expect.poll(() => embeddedRect(app!, webContentsId, '#run')).not.toBeNull()

    if (CAPTURE_VISUALS) {
      await page.screenshot({
        path: testInfo.outputPath('desktop-app-sandbox-ui-open.png'),
        fullPage: true,
      })
      await captureDesktopWindow(app, testInfo.outputPath('desktop-app-sandbox-ui-window-open.png'))
      await captureEmbeddedView(
        app,
        webContentsId,
        testInfo.outputPath('desktop-app-sandbox-ui-webcontents.png')
      )
      await attachVisualLayout(page, app, webContentsId, testInfo, 'open')
    }

    const marker = `desktop-sdk-${Date.now()}`

    await test.step('reject an empty prompt without creating an invocation', async () => {
      const before = sdkInvocationCount('promptBridge')
      await activateEmbedded(app!, webContentsId, '#run')
      await expect
        .poll(() => embeddedText(app!, webContentsId, '#prompt-out'))
        .toContain('Enter a prompt first.')
      expect(sdkInvocationCount('promptBridge')).toBe(before)
    })

    await test.step('run the real prompt through the embedded UI', async () => {
      await typeEmbedded(
        app!,
        webContentsId,
        '#prompt',
        `Reply with a short confirmation for test marker ${marker}.`
      )
      const before = sdkInvocationCount('promptBridge')
      await activateEmbedded(app!, webContentsId, '#run')
      await expect
        .poll(() => embeddedText(app!, webContentsId, '#prompt-out'), {
          timeout: 5_000,
          intervals: [1, 5, 10, 25, 50],
        })
        .toContain('Running…')
      await expect
        .poll(() => embeddedText(app!, webContentsId, '#prompt-out'), { timeout: 120_000 })
        .not.toMatch(/^(?:|Running…|Enter a prompt first\.)$/)
      await expect
        .poll(() => sdkInvocationCount('promptBridge'), { timeout: 30_000 })
        .toBe(before + 1)
      await expect
        .poll(() => latestSdkInvocationStatus('promptBridge'), { timeout: 30_000 })
        .toBe('complete')
    })
    const promptResult = await embeddedText(app, webContentsId, '#prompt-out')
    expect(promptResult).not.toMatch(/"error"|provider_unavailable|requires a resolvable agent/i)

    // Business signal for notifications: the real app loaded the grant-backed
    // recipient list and the native view selected a visible email handle. The
    // opaque userRef is produced by the select control, never typed by the test.
    await expect
      .poll(
        async () =>
          (await embeddedOptions(app!, webContentsId, '#userRef')).filter(
            option => option.value && /@/.test(option.label)
          ).length,
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
    // The sample UI receives exactly one grant-authorized recipient and the
    // native select therefore adopts it as its initial value. Verify that
    // visible grant-backed choice before continuing; the missing-field guard
    // below still proves the form rejects an incomplete notification without
    // creating an SDK invocation.
    await selectEmbeddedRecipient(app, webContentsId, '#userRef', credentials.email)
    await typeEmbedded(app, webContentsId, '#title', `Evenfire E2E ${marker}`)
    await test.step('reject a notification missing its body before the SDK call', async () => {
      const before = sdkInvocationCount('clientNotifications')
      await activateEmbedded(app!, webContentsId, '#notify')
      await expect
        .poll(() => embeddedText(app!, webContentsId, '#notify-out'))
        .toContain('Title and body are required.')
      expect(sdkInvocationCount('clientNotifications')).toBe(before)
    })
    await typeEmbedded(app, webContentsId, '#message', 'Plugin Workload SDK Desktop validation.')
    await expect
      .poll(() => embeddedValue(app!, webContentsId, '#title'))
      .toBe(`Evenfire E2E ${marker}`)
    await expect
      .poll(() => embeddedValue(app!, webContentsId, '#message'))
      .toBe('Plugin Workload SDK Desktop validation.')
    await activateEmbedded(app, webContentsId, '#notify')
    await expect
      .poll(() => embeddedText(app!, webContentsId, '#notify-out'), { timeout: 30_000 })
      .toMatch(/"notificationId"\s*:\s*"[0-9a-f-]{36}"/i)
    const notificationResult = await embeddedText(app, webContentsId, '#notify-out')
    const notificationId = notificationResult.match(
      /"notificationId"\s*:\s*"([0-9a-f-]{36})"/i
    )?.[1]
    expect(notificationId).toBeTruthy()
    await expect
      .poll(() => latestSdkInvocationStatus('clientNotifications'), { timeout: 30_000 })
      .toMatch(/^(accepted|delivered)$/)
    await expect
      .poll(() => notificationDeliverySignal(notificationId!), { timeout: 30_000 })
      .toMatch(/^plugin_workload_sdk\.notification\|(queued|retrying|sent)$/)

    // Prove the end-user journey in the Desktop shell, not only the embedded
    // app response or the persisted delivery signal: the notification must be
    // visible in the authenticated inbox with the unique marker from this run.
    await test.step('open the Desktop notification inbox and read the delivered item', async () => {
      const bell = page!.getByTestId('notification-bell')
      await expect(bell).toBeVisible({ timeout: 20_000 })
      await bell.click()
      await expect(bell).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 })
      const inbox = page!.getByRole('dialog', { name: 'Notifications and approvals' })
      await expect(inbox).toBeVisible({ timeout: 20_000 })
      const deliveredItem = inbox
        .getByTestId('notification-menu-item')
        .filter({ hasText: `Evenfire E2E ${marker}` })
      await expect(deliveredItem).toBeVisible({ timeout: 30_000 })
      await expect(inbox).not.toContainText('No notifications or pending approvals right now.')
      await bell.click()
      await expect(bell).toHaveAttribute('aria-expanded', 'false', { timeout: 20_000 })
    })

    if (CAPTURE_VISUALS) {
      await page.screenshot({
        path: testInfo.outputPath('desktop-app-sandbox-ui-complete.png'),
        fullPage: true,
      })
      await captureDesktopWindow(
        app,
        testInfo.outputPath('desktop-app-sandbox-ui-window-complete.png')
      )
      await captureEmbeddedView(
        app,
        webContentsId,
        testInfo.outputPath('desktop-app-sandbox-ui-webcontents-complete.png')
      )
      await attachVisualLayout(page, app, webContentsId, testInfo, 'complete')
    }

    // Renderer chrome + native view both remain alive after the two backend
    // operations, proving the Desktop Apps path rather than a direct proxy call.
    await expect(page.getByRole('button', { name: 'Back to apps' })).toBeVisible()
    expect(await findPromptNotifyContents(app)).toMatchObject({ id: webContentsId })
    await page.getByRole('button', { name: 'Back to apps' }).click()
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
  } finally {
    await finalizeRecording(app, page)
  }
})
