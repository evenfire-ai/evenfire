import { afterEach, describe, expect, it, vi } from 'vitest'

const SAMPLES = {
  http: 'http://example.com/',
  https: 'https://evenfire.ai/',
  mailto: 'mailto:someone@example.com',
} as const

afterEach(() => {
  vi.doUnmock('../urlScheme')
  vi.resetModules()
})

/** The real href policy and the real click core, loaded against `allowed`. */
async function renderAndClickWith(allowed: readonly string[] | null) {
  if (allowed) {
    vi.doMock('../urlScheme', async importOriginal => ({
      ...(await importOriginal<typeof import('../urlScheme')>()),
      EXTERNAL_LINK_SCHEMES: new Set(allowed),
    }))
  }
  const { canonicalChatLinkHref } = await import('../chatMessageSemantics')
  const { createChatLinkActivation } = await import('../chatLinkActivation')
  const opened: string[] = []
  const activate = createChatLinkActivation({
    beginUserNavigationIntent: () => 1,
    isNavigationIntentCurrent: () => true,
    openPreviewSection: () => {},
    openFilesSection: () => {},
    pushToast: () => {},
    resolveForNavigation: async () => ({ status: 'superseded' }),
    openUrl: async url => {
      opened.push(url)
    },
  })
  const outcome: Record<string, { rendered: boolean; opened: boolean }> = {}
  for (const [scheme, href] of Object.entries(SAMPLES)) {
    const rendered = canonicalChatLinkHref(href)
    // The click is fed the raw href, not the policy's output, so a click core
    // that still opened a scheme the policy dropped would show up here.
    opened.length = 0
    await activate(href)
    outcome[scheme] = { rendered: rendered !== null, opened: opened.length === 1 }
  }
  return outcome
}

describe('EXTERNAL_LINK_SCHEMES', () => {
  it('renders and opens exactly the shared schemes', async () => {
    expect(await renderAndClickWith(null)).toEqual({
      http: { rendered: true, opened: true },
      https: { rendered: true, opened: true },
      mailto: { rendered: true, opened: true },
    })
  })

  it.each(Object.keys(SAMPLES))(
    'removing %s from the shared list stops both rendering and opening it',
    async removed => {
      const allowed = Object.keys(SAMPLES).filter(scheme => scheme !== removed)
      const outcome = await renderAndClickWith(allowed)
      for (const scheme of Object.keys(SAMPLES)) {
        const kept = scheme !== removed
        expect(outcome[scheme], scheme).toEqual({ rendered: kept, opened: kept })
      }
    }
  )
})
