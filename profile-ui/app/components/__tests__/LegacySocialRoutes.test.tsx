import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`)
  },
}))

// Glob discovery lets a missing compatibility page fail an assertion, rather
// than hiding the regression behind a module-resolution failure.
const pages = import.meta.glob<{
  default: (props: { params: Promise<{ network: string }> }) => unknown
}>('../../settings/social/**/page.tsx')

describe('Legacy social links delivered by Desktop and channel-reader', () => {
  it('redirects the legacy section to Social channels', async () => {
    const load = pages['../../settings/social/page.tsx']
    expect(load, 'the legacy social section must remain routable').toBeDefined()
    const page = await load!()
    expect(() => page.default({ params: Promise.resolve({ network: '' }) })).toThrow(
      'redirect:/channels'
    )
  })

  it.each(['telegram', 'slack', 'teams'])('preserves legacy %s connection links', async network => {
    const load = pages['../../settings/social/[network]/page.tsx']
    expect(load, 'legacy provider links must remain routable').toBeDefined()
    const page = await load!()
    await expect(page.default({ params: Promise.resolve({ network }) })).rejects.toThrow(
      `redirect:/channels/${network}`
    )
  })
})
