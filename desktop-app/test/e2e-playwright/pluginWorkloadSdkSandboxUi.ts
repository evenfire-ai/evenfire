import { type ElectronApplication, type Page, type TestInfo, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  profilesSql,
  sqlLiteral,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'

/*
 * Shared Plugin Workload SDK sandbox-UI journey helpers.
 *
 * Both Desktop SDK specs (the paid happy path and the no-grant Codex guard)
 * drive the same Electron/WebContentsView surface, but they REQUIRE opposite
 * cluster state: `pluginWorkloadSdk.state === 'validated'` for one and
 * `awaiting_policy` for the other. Keeping the recipe identity in module-level
 * constants made that impossible to express — a single process could only ever
 * point at one recipe, so enabling both tests guaranteed one failure.
 *
 * Every helper here therefore takes an explicit `SandboxUiFixture` instead of
 * reading module constants, and each spec owns its own fixture (and its own
 * Make target). No default recipe is baked in on the no-grant side: an unset
 * fixture must fail loudly, never silently borrow the happy-path recipe.
 */

/** Recipe identity plus the Desktop Apps catalog title of one sandbox-UI app. */
export type SandboxUiFixture = {
  recipeName: string
  recipeNamespace: string
  appTitle: string
}

export type EmbeddedContents = { id: number; url: string }
export type Rect = { x: number; y: number; width: number; height: number }
export type EmbeddedOption = { value: string; label: string }
export type NativeLayout = {
  windowBounds: Rect
  viewBounds: Rect | null
  displayScaleFactor: number
  mainRendererDpr: number
  embeddedRendererDpr: number | null
  embeddedCaptureSize: { width: number; height: number } | null
}

export type PluginWorkloadSdkStatus = {
  state: string
  bootstrapContractVersion: number | null
  message: string
}

/**
 * Providers a Desktop SDK candidate recipe may declare. The lane is shared:
 * `scripts/e2e/seed-e2e-data.sh` provisions OpenAI/Claude demo grants by
 * default, so restricting the whole spec to Codex would break the seeded local
 * fixture. The run's expected provider is declared by the operator instead
 * (see `requireExpectedSdkProvider`) and asserted against the live recipe.
 */
export const SUPPORTED_SDK_PROVIDERS = ['openai', 'claude', 'codex-subscription'] as const
export type SupportedSdkProvider = (typeof SUPPORTED_SDK_PROVIDERS)[number]

const DNS_1123_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export function k8sContext(): string {
  const context =
    process.env.E2E_K8S_CONTEXT || process.env.KUBECONTEXT || process.env.K8S_CONTEXT || ''
  if (!context) throw new Error('E2E_K8S_CONTEXT is required for the Plugin Workload SDK lane.')
  return context
}

/**
 * Validate a fixture supplied by the operator. `envPrefix` names the variable
 * family the values came from so a rejected value points at the exact knob.
 */
export function assertSandboxUiFixture(
  fixture: SandboxUiFixture,
  envPrefix: string
): SandboxUiFixture {
  if (!DNS_1123_LABEL.test(fixture.recipeName)) {
    throw new Error(`Unsafe ${envPrefix}_RECIPE_NAME: ${fixture.recipeName}`)
  }
  if (!DNS_1123_LABEL.test(fixture.recipeNamespace)) {
    throw new Error(`Unsafe ${envPrefix}_RECIPE_NAMESPACE: ${fixture.recipeNamespace}`)
  }
  if (!fixture.appTitle.trim()) {
    throw new Error(`${envPrefix}_APP_TITLE is required to locate the Desktop Apps catalog card.`)
  }
  return fixture
}

/**
 * Read the provider this run claims to prove. Required, with no default: a run
 * that does not state which provider it exercises cannot be presented as
 * evidence for any of them.
 */
export function requireExpectedSdkProvider(envKey: string): SupportedSdkProvider {
  const raw = (process.env[envKey] ?? '').trim().toLowerCase()
  if (!raw) {
    throw new Error(
      `${envKey} is required; declare which provider this Desktop SDK run must exercise ` +
        `(${SUPPORTED_SDK_PROVIDERS.join(' | ')}).`
    )
  }
  const provider = SUPPORTED_SDK_PROVIDERS.find(candidate => candidate === raw)
  if (!provider) {
    throw new Error(
      `Unsupported ${envKey}: ${raw}. Expected one of ${SUPPORTED_SDK_PROVIDERS.join(', ')}.`
    )
  }
  return provider
}

function readRecipe(fixture: SandboxUiFixture): {
  spec?: {
    steps?: unknown
    triggers?: unknown
    agent?: { provider?: unknown; model?: unknown }
    workloads?: unknown
    pluginWorkloadSdk?: { promptBridge?: Record<string, unknown> }
  }
  status?: {
    pluginWorkloadSdk?: {
      state?: unknown
      bootstrapContractVersion?: unknown
      message?: unknown
    }
  }
} {
  const raw = execFileSync(
    'kubectl',
    [
      '--context',
      k8sContext(),
      '-n',
      fixture.recipeNamespace,
      'get',
      'workflowrecipe',
      fixture.recipeName,
      '-o',
      'json',
    ],
    { encoding: 'utf8', timeout: 30_000 }
  )
  return JSON.parse(raw)
}

/**
 * Read-only precondition for an SDK-only Desktop candidate recipe.
 *
 * `expectedProvider` is asserted against the live recipe rather than merely
 * accepted from an allowlist: a recipe that silently lost its Codex binding
 * would otherwise keep this journey green while it exercised a different
 * provider entirely.
 */
export function assertSteplessSdkRecipePrecondition(
  fixture: SandboxUiFixture,
  expectedProvider: SupportedSdkProvider
): { provider: string; model: string } {
  const recipe = readRecipe(fixture)
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
  const provider = spec.agent.provider.toLowerCase()
  if (provider !== expectedProvider) {
    throw new Error(
      `Desktop SDK run declared provider ${expectedProvider} but recipe ` +
        `${fixture.recipeNamespace}/${fixture.recipeName} declares ${spec.agent.provider}. ` +
        'Refusing to report this run as evidence for a provider it does not exercise.'
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
  return { provider: spec.agent.provider, model: spec.agent.model }
}

export function readPluginWorkloadSdkStatus(fixture: SandboxUiFixture): PluginWorkloadSdkStatus {
  const sdk = readRecipe(fixture).status?.pluginWorkloadSdk ?? {}
  return {
    state: typeof sdk.state === 'string' ? sdk.state : '',
    bootstrapContractVersion:
      sdk.bootstrapContractVersion === 2 || sdk.bootstrapContractVersion === 3
        ? sdk.bootstrapContractVersion
        : null,
    message: typeof sdk.message === 'string' ? sdk.message : '',
  }
}

export function sandboxUiViewUrlPrefix(fixture: SandboxUiFixture): string {
  return `/api/v1/sandbox-ui/${encodeURIComponent(fixture.recipeNamespace)}/${encodeURIComponent(
    fixture.recipeName
  )}/view/`
}

export async function findSandboxUiContents(
  app: ElectronApplication,
  fixture: SandboxUiFixture
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
  }, fixture.appTitle)
}

export async function embeddedRect(
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

export async function embeddedText(
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

export async function embeddedValue(
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

export async function embeddedOptions(
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

export async function embeddedActiveControl(
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

export async function embeddedActiveSignature(
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
export async function captureEmbeddedView(
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
export async function captureDesktopWindow(
  app: ElectronApplication,
  outputPath: string
): Promise<void> {
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
export async function nativeEmbeddedLayout(
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

export async function attachVisualLayout(
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

export async function sendEmbeddedKey(
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

export async function focusEmbeddedControl(
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

export async function typeEmbedded(
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

export async function activateEmbedded(
  app: ElectronApplication,
  webContentsId: number,
  selector: string
): Promise<void> {
  await focusEmbeddedControl(app, webContentsId, selector)
  await sendEmbeddedKey(app, webContentsId, 'Enter')
}

export async function selectEmbeddedRecipient(
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

export function sdkInvocationCount(
  fixture: SandboxUiFixture,
  method: 'promptBridge' | 'clientNotifications'
): number {
  const raw = profilesSql(`
    SELECT count(*)::int
      FROM plugin_workload_sdk_invocations
     WHERE recipe_namespace = ${sqlLiteral(fixture.recipeNamespace)}
       AND recipe_name = ${sqlLiteral(fixture.recipeName)}
       AND method = ${sqlLiteral(method)};
  `)
  return Number.parseInt(raw, 10) || 0
}

export function promptBridgeLedgerForRun(
  fixture: SandboxUiFixture,
  startedAt: string
): {
  invocationId: string
  sdkAttemptId: string
  codexAttemptId: string
  spendOutcome: string
} {
  const raw = profilesSql(`
    SELECT inv.id::text || '|' || sdk.id::text || '|' ||
           coalesce(codex.id::text, '') || '|' || coalesce(spend.outcome, '')
      FROM plugin_workload_sdk_invocations inv
      JOIN plugin_workload_sdk_provider_attempts sdk
        ON sdk.invocation_id = inv.id
      LEFT JOIN llm_provider_attempts codex
        ON codex.plugin_workload_sdk_provider_attempt_id = sdk.id
      LEFT JOIN plugin_workload_sdk_spend_outcomes spend
        ON spend.provider_attempt_id = sdk.id
     WHERE inv.recipe_namespace = ${sqlLiteral(fixture.recipeNamespace)}
       AND inv.recipe_name = ${sqlLiteral(fixture.recipeName)}
       AND inv.method = 'promptBridge'
       AND inv.created_at >= ${sqlLiteral(startedAt)}::timestamptz
     ORDER BY inv.created_at ASC, sdk.attempt_index ASC
     LIMIT 1;
  `)
  const [invocationId, sdkAttemptId, codexAttemptId, spendOutcome] = raw.trim().split('|')
  return {
    invocationId: invocationId ?? '',
    sdkAttemptId: sdkAttemptId ?? '',
    codexAttemptId: codexAttemptId ?? '',
    spendOutcome: spendOutcome ?? '',
  }
}

/**
 * The run anchor, read from PostgreSQL rather than the runner.
 *
 * The ledger queries filter on `inv.created_at >= startedAt`, and
 * `created_at` is written by the database. Anchoring with the runner's clock
 * compares two unsynchronised clocks, so a few seconds of skew either drops
 * the run's own rows or picks up an earlier one. Same clock, both sides.
 */
export function profilesNow(): string {
  return profilesSql('SELECT now()::text').trim()
}

export type PromptBridgeAttemptRow = {
  attemptIndex: number
  targetRef: string
  provider: string
  model: string
  status: string
  spendOutcome: string
  codexAttemptId: string
}

/**
 * Every physical attempt of the run's first promptBridge invocation, ordered by
 * `attempt_index`.
 *
 * `promptBridgeLedgerForRun` answers "what did the served attempt record", so
 * it stops at `LIMIT 1`. A failover journey needs the opposite: the displaced
 * attempt is the evidence. Attempt 0 never reaches `finalize` when a later
 * target wins, so its spend floor is written by
 * `settlePriorProviderAttemptFloors` — the server-side discovery that replaced
 * a client-declared `priorAttempts` field. Reading every row is what proves
 * that path ran at all.
 */
export function promptBridgeAttemptsForRun(
  fixture: SandboxUiFixture,
  startedAt: string
): PromptBridgeAttemptRow[] {
  const raw = profilesSql(`
    SELECT sdk.attempt_index::text || '|' || sdk.target_ref || '|' || sdk.provider || '|' ||
           sdk.model || '|' || sdk.status || '|' || coalesce(spend.outcome, '') || '|' ||
           coalesce(codex.id::text, '')
      FROM plugin_workload_sdk_invocations inv
      JOIN plugin_workload_sdk_provider_attempts sdk
        ON sdk.invocation_id = inv.id
      LEFT JOIN llm_provider_attempts codex
        ON codex.plugin_workload_sdk_provider_attempt_id = sdk.id
      LEFT JOIN plugin_workload_sdk_spend_outcomes spend
        ON spend.provider_attempt_id = sdk.id
     WHERE inv.recipe_namespace = ${sqlLiteral(fixture.recipeNamespace)}
       AND inv.recipe_name = ${sqlLiteral(fixture.recipeName)}
       AND inv.method = 'promptBridge'
       AND inv.created_at >= ${sqlLiteral(startedAt)}::timestamptz
       AND inv.id = (
         SELECT id FROM plugin_workload_sdk_invocations
          WHERE recipe_namespace = ${sqlLiteral(fixture.recipeNamespace)}
            AND recipe_name = ${sqlLiteral(fixture.recipeName)}
            AND method = 'promptBridge'
            AND created_at >= ${sqlLiteral(startedAt)}::timestamptz
          ORDER BY created_at ASC
          LIMIT 1
       )
     ORDER BY sdk.attempt_index ASC;
  `)
  if (!raw.trim()) return []
  return raw
    .trim()
    .split('\n')
    .map(line => {
      const [attemptIndex, targetRef, provider, model, status, spendOutcome, codexAttemptId] = line
        .trim()
        .split('|')
      return {
        attemptIndex: Number.parseInt(attemptIndex ?? '', 10),
        targetRef: targetRef ?? '',
        provider: provider ?? '',
        model: model ?? '',
        status: status ?? '',
        spendOutcome: spendOutcome ?? '',
        codexAttemptId: codexAttemptId ?? '',
      }
    })
}

/**
 * The ordered promptBridge targets on the live grant.
 *
 * A failover journey that runs against a single-target grant would pass while
 * proving nothing — there would be nowhere to fall to. This is asserted before
 * the fault is injected so an unprovisioned fixture fails as a precondition,
 * not as a mysteriously green run.
 */
export function promptBridgeGrantTargets(
  fixture: SandboxUiFixture
): Array<{ targetRef: string; provider: string }> {
  const raw = profilesSql(`
    SELECT string_agg(t->>'targetRef' || '|' || (t->>'provider'), E'\\n' ORDER BY ord)
      FROM plugin_workload_sdk_grants g
      CROSS JOIN LATERAL jsonb_array_elements(g.prompt_targets) WITH ORDINALITY AS a(t, ord)
     WHERE g.recipe_namespace = ${sqlLiteral(fixture.recipeNamespace)}
       AND g.recipe_name = ${sqlLiteral(fixture.recipeName)}
       AND g.capability_family = 'promptBridge';
  `)
  if (!raw.trim()) return []
  return raw
    .trim()
    .split('\n')
    .map(line => {
      const [targetRef, provider] = line.trim().split('|')
      return { targetRef: targetRef ?? '', provider: provider ?? '' }
    })
}

export function latestSdkInvocationStatus(
  fixture: SandboxUiFixture,
  method: 'promptBridge' | 'clientNotifications'
): string {
  return profilesSql(`
    SELECT status
      FROM plugin_workload_sdk_invocations
     WHERE recipe_namespace = ${sqlLiteral(fixture.recipeNamespace)}
       AND recipe_name = ${sqlLiteral(fixture.recipeName)}
       AND method = ${sqlLiteral(method)}
     ORDER BY created_at DESC
     LIMIT 1;
  `)
}

export function notificationDeliverySignal(notificationId: string): string {
  return profilesSql(`
    SELECT event_type || '|' || status
      FROM notification_deliveries
     WHERE event_type = 'plugin_workload_sdk.notification'
       AND payload->>'notificationId' = ${sqlLiteral(notificationId)}
     LIMIT 1;
  `)
}
