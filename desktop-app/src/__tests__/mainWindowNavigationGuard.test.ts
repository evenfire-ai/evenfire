import { describe, expect, it, vi } from 'vitest'
import { wireMainWindowNavigationGuard } from '../mainWindowNavigationGuard.js'

type Listener = (event: { preventDefault(): void }, url: string) => void

function navigate(options: { devUrl: string; currentUrl: string; url: string }): boolean {
  let listener: Listener | undefined
  wireMainWindowNavigationGuard(
    {
      on: (_event, registered) => {
        listener = registered
      },
      getURL: () => options.currentUrl,
    },
    options.devUrl
  )
  if (!listener) throw new Error('will-navigate listener was not registered')
  const preventDefault = vi.fn()
  listener({ preventDefault }, options.url)
  return preventDefault.mock.calls.length > 0
}

const appFile = 'file:///Applications/Evenfire.app/Contents/Resources/ui-dist/index.html'
const devUrl = 'http://127.0.0.1:5173'

describe('main window will-navigate guard', () => {
  describe('production (S-1)', () => {
    it.each([
      [
        'a relative anchor resolved under ui-dist',
        'file:///Applications/Evenfire.app/Contents/Resources/ui-dist/x',
      ],
      ['the current document (href="" / location.reload)', appFile],
      ['a dev-server path', `${devUrl}/x`],
      ['an external site', 'https://evenfire.ai/'],
    ])('blocks %s', (_label, url) => {
      expect(navigate({ devUrl: '', currentUrl: appFile, url })).toBe(true)
    })
  })

  describe('dev (S-1b)', () => {
    const current = `${devUrl}/`

    it('allows a navigation to exactly the current document (Vite full reload)', () => {
      expect(navigate({ devUrl, currentUrl: current, url: current })).toBe(false)
    })

    it.each([
      ['another dev-server path', `${devUrl}/x`],
      ['a file:// document', appFile],
      ['an external site', 'https://evenfire.ai/'],
    ])('blocks %s', (_label, url) => {
      expect(navigate({ devUrl, currentUrl: current, url })).toBe(true)
    })
  })
})
