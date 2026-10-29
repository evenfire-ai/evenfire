// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { AuthContext } from '../../contexts/AuthContext'
import { UnavailablePage } from '../UnavailablePage'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

afterEach(() => cleanup())

const renderUnavailablePage = (overrides: Partial<AuthContextValue> = {}) => {
  const value = {
    busy: false,
    dependencyHealth: {
      externalRestApi: { ok: true },
      rpcProxy: { ok: false },
    },
    setBooting: vi.fn(),
    setStatus: vi.fn(),
    loadSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AuthContextValue

  return {
    value,
    ...render(
      <AuthContext.Provider value={value}>
        <UnavailablePage />
      </AuthContext.Provider>
    ),
  }
}

describe('UnavailablePage', () => {
  it('uses the same inner spacing as the other centered pre-auth cards', () => {
    renderUnavailablePage()

    const cardHeader = document.querySelector('.ant-card-head') as HTMLElement
    const cardBody = document.querySelector('.ant-card-body') as HTMLElement
    expect(cardHeader.style.paddingInline).toBe('32px')
    expect(cardBody.style.padding).toBe('32px')
  })

  it('shows the title, explanation, labeled dependency health and retry action', () => {
    renderUnavailablePage()

    expect(screen.getByRole('heading', { name: 'Services Unavailable', level: 1 })).toBeTruthy()
    expect(
      screen.getByText(
        'Cannot render authentication because one or more backend services are unavailable.'
      )
    ).toBeTruthy()
    expect(screen.getByText('external-rest-api').parentElement?.textContent).toContain('healthy')
    expect(screen.getByText('rpc-proxy').parentElement?.textContent).toContain('unavailable')
    expect(
      (screen.getByRole('button', { name: 'Retry Health Check' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('starts the existing session retry and allows the owner to complete it', async () => {
    const user = userEvent.setup()
    const { value, rerender } = renderUnavailablePage()

    await user.click(screen.getByRole('button', { name: 'Retry Health Check' }))
    expect(value.setBooting).toHaveBeenCalledWith(true)
    expect(value.loadSession).toHaveBeenCalledTimes(1)

    rerender(
      <AuthContext.Provider value={{ ...value, busy: true }}>
        <UnavailablePage />
      </AuthContext.Provider>
    )
    expect(
      (screen.getByRole('button', { name: 'Retry Health Check' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('reports retry failure through the existing status owner and clears booting', async () => {
    const user = userEvent.setup()
    const { value } = renderUnavailablePage({
      loadSession: vi.fn().mockRejectedValue(new Error('health endpoint timed out')),
    })

    await user.click(screen.getByRole('button', { name: 'Retry Health Check' }))

    expect(value.setStatus).toHaveBeenCalledWith(
      'Health recheck failed: health endpoint timed out',
      'error'
    )
    expect(value.setBooting).toHaveBeenNthCalledWith(1, true)
    expect(value.setBooting).toHaveBeenNthCalledWith(2, false)
  })
})
