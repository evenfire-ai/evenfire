import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
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

const RUN_ENABLED = process.env.E2E_PLUGIN_SDK_DESKTOP === '1'
const APP_TITLE = process.env.E2E_PLUGIN_SDK_APP_TITLE || 'Prompt & Notify'
const RECIPE_NAME = process.env.E2E_PLUGIN_SDK_RECIPE_NAME || 'evenfire-prompt-notify-app'
const RECIPE_NAMESPACE = process.env.E2E_PLUGIN_SDK_RECIPE_NAMESPACE || 'sandbox-recipes'

test.skip(
  !RUN_ENABLED,
  'Set E2E_PLUGIN_SDK_DESKTOP=1 for the branch-owned Electron/Apps/WebContentsView gate.'
)

type EmbeddedContents = { id: number; url: string }
type Rect = { x: number; y: number; width: number; height: number }

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
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page
    await login(page, desktopCredentials())

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

    const marker = `desktop-sdk-${Date.now()}`
    await typeEmbedded(
      app,
      webContentsId,
      '#prompt',
      `Reply with a short confirmation for test marker ${marker}.`
    )
    await activateEmbedded(app, webContentsId, '#run')
    await expect
      .poll(() => embeddedText(app!, webContentsId, '#prompt-out'), { timeout: 120_000 })
      .not.toMatch(/^(?:|Running…|Enter a prompt first\.)$/)
    const promptResult = await embeddedText(app, webContentsId, '#prompt-out')
    expect(promptResult).not.toMatch(/"error"|provider_unavailable|requires a resolvable agent/i)

    // Business signal for notifications: the real app loaded an authorized
    // opaque recipient, then the native view submitted and rendered acceptance.
    await expect
      .poll(() => embeddedValue(app!, webContentsId, '#userRef'), { timeout: 30_000 })
      .not.toBe('')
    await typeEmbedded(app, webContentsId, '#title', `Evenfire E2E ${marker}`)
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

    // Renderer chrome + native view both remain alive after the two backend
    // operations, proving the Desktop Apps path rather than a direct proxy call.
    await expect(page.getByRole('button', { name: 'Back to apps' })).toBeVisible()
    expect(await findPromptNotifyContents(app)).toMatchObject({ id: webContentsId })
  } finally {
    await finalizeRecording(app, page)
  }
})
