import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { type Browser, chromium } from 'playwright'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

type LandingGeometry = {
  slotWidth: number
  composerWidth: number
  leftInset: number
  rightInset: number
}

let browser: Browser | undefined

function launchOptions() {
  if (process.platform === 'darwin' && fs.existsSync(SYSTEM_CHROME)) {
    return { executablePath: SYSTEM_CHROME, headless: true }
  }
  return { headless: true }
}

/**
 * R3-M1 regression guard: the new-chat landing wraps its inline composer in
 * `.agent-workspace-new-chat`, which breaks the old
 * `.agent-workspace-body-slot > .composer-inline` direct-child chain used by
 * the `@media (max-width: 1220px)` gutter rule. Without the wrapper-aware
 * selector arm the landing composer renders full-bleed (no horizontal inset)
 * on laptop/narrow windows. Measures the real computed layout of the real
 * stylesheet in both mounts that share the DOM: the full-screen chat route
 * and the docked chat drawer (same <ChatPage>, narrower container).
 */
async function landingGeometry(
  viewportWidth: number,
  options: { drawerWidth?: number; slotWidth?: number } = {}
): Promise<LandingGeometry> {
  if (!browser) throw new Error('Browser must launch before measuring new-chat composer geometry')
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: 800 } })

  const slotStyle = options.slotWidth ? ` style="width: ${options.slotWidth}px"` : ''
  const landing = `
    <div class="agent-workspace-body-slot" data-slot${slotStyle}>
      <div class="agent-workspace-new-chat">
        <div class="agent-workspace-greeting-row">
          <h2 class="agent-workspace-greeting">Start a new conversation with:</h2>
        </div>
        <div class="composer composer-inline" data-composer>
          <div class="composer-input-shell"><textarea></textarea></div>
        </div>
      </div>
    </div>
  `

  if (options.drawerWidth) {
    // The drawer mounts the SAME ChatPage landing inside a fixed right rail.
    await page.setContent(`
      <div class="chat-drawer is-ready" style="--chat-drawer-width: ${options.drawerWidth}px">
        <div class="chat-drawer__resize-handle" role="separator"></div>
        <header class="chat-drawer__header"><div class="chat-drawer__header-main">drawer</div></header>
        <div class="chat-drawer__surface">${landing}</div>
      </div>
    `)
  } else {
    await page.setContent(landing)
  }

  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
  const geometry = await page.evaluate(() => {
    const slot = document.querySelector('[data-slot]')!.getBoundingClientRect()
    const composer = document.querySelector('[data-composer]')!.getBoundingClientRect()
    return {
      slotWidth: slot.width,
      composerWidth: composer.width,
      leftInset: composer.left - slot.left,
      rightInset: slot.right - composer.right,
    }
  })
  await page.close()
  return geometry
}

describe('new-chat composer responsive gutter', () => {
  beforeAll(async () => {
    browser = await chromium.launch(launchOptions())
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('keeps the --space-3 horizontal inset below the 1220px breakpoint (full-screen route)', async () => {
    // A sub-cap slot is the regression case: before the wrapper-aware selector
    // the composer fell back to the base min(100%, 920px) rule and rendered
    // FULL-BLEED (0 inset) at laptop widths. The responsive rule must inset it
    // by --space-3 (14px) on both sides.
    const narrow = await landingGeometry(1100, { slotWidth: 800 })
    expect(narrow.slotWidth).toBeCloseTo(800, 5)
    expect(narrow.leftInset).toBeCloseTo(14, 5)
    expect(narrow.rightInset).toBeCloseTo(14, 5)
    expect(narrow.composerWidth).toBeCloseTo(800 - 28, 5)
  })

  it('centers the composer against the 1024px cap on a wide sub-breakpoint slot', async () => {
    // slot wider than cap: width = min(slot - 28, 1024), centered by auto margins.
    const capped = await landingGeometry(1100, { slotWidth: 1100 })
    expect(capped.composerWidth).toBeCloseTo(1024, 5)
    expect(capped.leftInset).toBeCloseTo((1100 - 1024) / 2, 5)
    expect(capped.rightInset).toBeCloseTo((1100 - 1024) / 2, 5)
  })

  it('matches the gutter at the exact 1220px boundary', async () => {
    const boundary = await landingGeometry(1220, { slotWidth: 800 })
    expect(boundary.leftInset).toBeCloseTo(14, 5)
    expect(boundary.rightInset).toBeCloseTo(14, 5)
    expect(boundary.composerWidth).toBeCloseTo(800 - 28, 5)
  })

  it('keeps the same inset inside the docked chat drawer (shared ChatPage DOM)', async () => {
    const drawer = await landingGeometry(1100, { drawerWidth: 460 })
    // The drawer narrows the landing to 460px; the gutter must survive the
    // narrower container exactly as in the full-screen route.
    expect(drawer.slotWidth).toBeCloseTo(460, 5)
    expect(drawer.leftInset).toBeCloseTo(14, 5)
    expect(drawer.rightInset).toBeCloseTo(14, 5)
    expect(drawer.composerWidth).toBeCloseTo(460 - 28, 5)
  })

  it('still applies the wide-viewport 920px cap, not the responsive gutter, above the breakpoint', async () => {
    // Above 1220px the base wrapped rule owns the landing composer:
    // min(100%, 920px) centered. Guards against the media arm leaking wide.
    const wide = await landingGeometry(1440, { slotWidth: 1000 })
    expect(wide.slotWidth).toBeCloseTo(1000, 5)
    expect(wide.composerWidth).toBeCloseTo(920, 5)
    expect(wide.leftInset).toBeCloseTo((1000 - 920) / 2, 5)
    expect(wide.rightInset).toBeCloseTo((1000 - 920) / 2, 5)
  })
})
