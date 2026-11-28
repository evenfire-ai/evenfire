import React, { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createHash, randomBytes } from 'node:crypto'
import { PROFILE_ROUTES } from '@constants/routes'
import { edgeRecord, edgeResponse } from '@/test/edgeFixtures'
import DesktopLoginPage from '../../desktop-login/page'

const mocks = vi.hoisted(() => ({ navigateToDesktopApp: vi.fn() }))

vi.mock('@lib/desktopAppLinks', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/desktopAppLinks')>()
  return { ...actual, navigateToDesktopApp: mocks.navigateToDesktopApp }
})

vi.mock('next/image', () => ({
  default: ({ alt = '', ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}))

const CONFIGURATION_PATH = '/external-rest-api/api/v1/oidc/profile-flow/configuration'
const CONFIGURATION_ACTIVATED = 'GET /api/v1/oidc/profile-flow/configuration activated'
const LABEL = (edgeRecord(CONFIGURATION_ACTIVATED).body as { displayLabel: string }).displayLabel

/** A fresh RFC 7636 S256 challenge and state, as Evenfire Desktop makes them: 43 characters. */
const CHALLENGE = createHash('sha256')
  .update(randomBytes(32).toString('base64url'))
  .digest('base64url')
const STATE = randomBytes(32).toString('base64url')
const UNAVAILABLE_LINK = `evenfire://desktop-login?state=${STATE}&error=unavailable`

const INVALID_COPY = 'This sign-in link is not valid. Start again from Evenfire Desktop.'
const UNAVAILABLE_COPY = "Desktop sign-in isn't available here."

const fetchMock = vi.fn()

function openAt(url: string) {
  window.history.replaceState(null, '', url)
}

/** StrictMode runs each mount effect twice, as `next dev` does, so "once" can fail. */
function renderPage() {
  return render(
    <StrictMode>
      <DesktopLoginPage />
    </StrictMode>
  )
}

function answerActivated() {
  fetchMock.mockImplementation(async () => edgeResponse(CONFIGURATION_ACTIVATED))
}

async function findContinue(): Promise<HTMLButtonElement> {
  return screen.findByRole<HTMLButtonElement>('button', { name: `Continue with ${LABEL}` })
}

beforeEach(() => {
  fetchMock.mockReset()
  mocks.navigateToDesktopApp.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  openAt('/')
})

describe('Desktop sign-in page', () => {
  it('reads the values from the fragment and posts them to /api/oidc/desktop-start', async () => {
    openAt(`${PROFILE_ROUTES.desktopLogin}#challenge=${CHALLENGE}&state=${STATE}`)
    answerActivated()

    renderPage()

    const button = await findContinue()
    const form = button.closest('form')
    expect(form).not.toBeNull()
    if (!form) return
    expect(form.getAttribute('action')).toBe('/api/oidc/desktop-start')
    expect(form.getAttribute('action')).not.toBe(PROFILE_ROUTES.oidcStart)
    expect(form.getAttribute('method')).toBe('post')
    // What a browser sends when this button submits the form: exactly the two hidden values.
    // /api/oidc/desktop-start refuses any other field, a named submit button included.
    expect([...new FormData(form, button)]).toEqual([
      ['desktopChallenge', CHALLENGE],
      ['desktopState', STATE],
    ])
    for (const input of form.querySelectorAll('input')) expect(input.type).toBe('hidden')
    expect(button).toHaveAttribute('type', 'submit')
    expect(button).toHaveClass('cu-btn--primary')
    expect(button).toBeEnabled()

    const brand = screen.getAllByRole('heading', { level: 1 })
    expect(brand).toHaveLength(1)
    expect(brand[0]).toHaveTextContent('Evenfire')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Sign in to Evenfire Desktop'
    )
    expect(
      screen.getByText('This signs in the Evenfire Desktop app on this computer.')
    ).toBeInTheDocument()

    // The panel asks only for the provider label: no session read, no other call.
    expect(fetchMock).toHaveBeenCalled()
    for (const [url] of fetchMock.mock.calls) expect(url).toBe(CONFIGURATION_PATH)
    expect(mocks.navigateToDesktopApp).not.toHaveBeenCalled()
  })

  it('treats values in the query string as an invalid link', async () => {
    openAt(`${PROFILE_ROUTES.desktopLogin}?challenge=${CHALLENGE}&state=${STATE}`)
    answerActivated()

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID_COPY)
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('form')).toBeNull()
    expect(mocks.navigateToDesktopApp).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a challenge one character short', `challenge=${CHALLENGE.slice(1)}&state=${STATE}`],
    ['a challenge outside base64url', `challenge=${CHALLENGE.slice(1)}.&state=${STATE}`],
    ['no challenge', `state=${STATE}`],
  ])('fires unavailable once when only the state is well formed: %s', async (_name, fragment) => {
    openAt(`${PROFILE_ROUTES.desktopLogin}#${fragment}`)
    answerActivated()

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID_COPY)
    expect(mocks.navigateToDesktopApp).toHaveBeenCalledOnce()
    expect(mocks.navigateToDesktopApp).toHaveBeenCalledWith(UNAVAILABLE_LINK)
    expect(screen.queryByRole('button')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a second state', `challenge=${CHALLENGE}&state=${STATE}&state=${STATE}`, null],
    [
      'a second, different state',
      `challenge=${CHALLENGE}&state=${STATE}&state=${randomBytes(32).toString('base64url')}`,
      null,
    ],
    [
      'a second challenge',
      `challenge=${CHALLENGE}&challenge=${CHALLENGE}&state=${STATE}`,
      UNAVAILABLE_LINK,
    ],
    [
      'an extra key',
      `challenge=${CHALLENGE}&state=${STATE}&returnTo=desktop-setup`,
      UNAVAILABLE_LINK,
    ],
  ])('treats a duplicate or extra fragment key as invalid: %s', async (_name, fragment, link) => {
    openAt(`${PROFILE_ROUTES.desktopLogin}#${fragment}`)
    answerActivated()

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID_COPY)
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('form')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    // Only a single well-formed state may receive a link (design section 8).
    if (link === null) {
      expect(mocks.navigateToDesktopApp).not.toHaveBeenCalled()
    } else {
      expect(mocks.navigateToDesktopApp).toHaveBeenCalledOnce()
      expect(mocks.navigateToDesktopApp).toHaveBeenCalledWith(link)
    }
  })

  it.each([
    ['the configuration request fails', () => Promise.reject(new TypeError('network down'))],
    [
      'member sign-in is off',
      // Derived from the recorded `configuration activated` answer: edge.json records no
      // configuration with member sign-in off, so only that flag is switched.
      async () => {
        const record = edgeRecord(CONFIGURATION_ACTIVATED)
        return new Response(
          JSON.stringify({
            ...(record.body as Record<string, unknown>),
            memberAuthenticationActivated: false,
          }),
          { status: record.status, headers: { 'content-type': 'application/json' } }
        )
      },
    ],
  ])(
    'shows unavailable and fires the link when no provider label is available: %s',
    async (_name, answer) => {
      openAt(`${PROFILE_ROUTES.desktopLogin}#challenge=${CHALLENGE}&state=${STATE}`)
      fetchMock.mockImplementation(answer)

      renderPage()

      expect(await screen.findByRole('alert')).toHaveTextContent(UNAVAILABLE_COPY)
      await waitFor(() => expect(mocks.navigateToDesktopApp).toHaveBeenCalled())
      expect(mocks.navigateToDesktopApp).toHaveBeenCalledOnce()
      expect(mocks.navigateToDesktopApp).toHaveBeenCalledWith(UNAVAILABLE_LINK)
      expect(screen.queryByRole('button')).toBeNull()
      expect(document.querySelector('form')).toBeNull()
      expect(fetchMock).toHaveBeenCalled()
      for (const [url] of fetchMock.mock.calls) expect(url).toBe(CONFIGURATION_PATH)
    }
  )

  it('fires nothing when the page is left before the label answers', async () => {
    openAt(`${PROFILE_ROUTES.desktopLogin}#challenge=${CHALLENGE}&state=${STATE}`)
    const pending: Array<(reason: unknown) => void> = []
    fetchMock.mockImplementation(
      () => new Promise<Response>((_resolve, reject) => pending.push(reject))
    )

    const { unmount } = renderPage()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    unmount()
    await act(async () => {
      for (const reject of pending) reject(new TypeError('network down'))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(pending.length).toBeGreaterThan(0)
    expect(mocks.navigateToDesktopApp).not.toHaveBeenCalled()
  })

  it('disables Continue after the first submit', async () => {
    openAt(`${PROFILE_ROUTES.desktopLogin}#challenge=${CHALLENGE}&state=${STATE}`)
    answerActivated()
    renderPage()
    const button = await findContinue()
    const form = button.closest('form')
    expect(form).not.toBeNull()
    if (!form) return

    // Runs after the page's own submit handler (React listens below the document). It records
    // whether the page let each submission through, then cancels it, because jsdom cannot
    // navigate.
    const passedThrough: boolean[] = []
    const record = (event: Event) => {
      passedThrough.push(!event.defaultPrevented)
      event.preventDefault()
    }
    document.addEventListener('submit', record)
    try {
      fireEvent.click(button)
      expect(passedThrough).toEqual([true])
      expect(button).toBeDisabled()

      // The second click of a double-click lands on a disabled button and submits nothing.
      fireEvent.click(button)
      expect(passedThrough).toEqual([true])

      // A submission that does not come through the button is stopped by the handler.
      fireEvent.submit(form)
      expect(passedThrough).toEqual([true, false])
    } finally {
      document.removeEventListener('submit', record)
    }
  })

  it('enables Continue again when Back restores the page from the back/forward cache', async () => {
    openAt(`${PROFILE_ROUTES.desktopLogin}#challenge=${CHALLENGE}&state=${STATE}`)
    answerActivated()
    renderPage()
    const button = await findContinue()
    const form = button.closest('form')
    expect(form).not.toBeNull()
    if (!form) return

    // As in the double-click test: records whether the page let each submission through.
    const passedThrough: boolean[] = []
    const record = (event: Event) => {
      passedThrough.push(!event.defaultPrevented)
      event.preventDefault()
    }
    document.addEventListener('submit', record)
    try {
      fireEvent.click(button)
      expect(passedThrough).toEqual([true])
      expect(button).toBeDisabled()

      // An ordinary page show is not a restore: Continue stays disabled and guarded.
      fireEvent(window, new PageTransitionEvent('pageshow', { persisted: false }))
      expect(button).toBeDisabled()
      fireEvent.submit(form)
      expect(passedThrough).toEqual([true, false])

      // Back from the provider restores the page as it was left. Continue starts a new attempt.
      fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))
      expect(button).toBeEnabled()
      fireEvent.click(button)
      expect(passedThrough).toEqual([true, false, true])
      expect(button).toBeDisabled()
    } finally {
      document.removeEventListener('submit', record)
    }
  })
})
