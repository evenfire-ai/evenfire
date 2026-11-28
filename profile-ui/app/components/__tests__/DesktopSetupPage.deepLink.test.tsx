import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import handoffGolden from '@/test/fixtures/desktop-handoff-links.golden.json'
import DesktopSetupPage from '../../desktop-setup/page'

const api = vi.hoisted(() => ({
  createDesktopAuthorization: vi.fn(),
}))
const navigation = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}))

vi.mock('@lib/api', () => ({
  createDesktopAuthorization: api.createDesktopAuthorization,
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigation.searchParams,
}))

let location: { href: string }

beforeEach(() => {
  api.createDesktopAuthorization.mockReset()
  location = { href: 'https://profile.example.com/desktop-setup' }
  vi.stubGlobal('location', location)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DesktopSetupPage desktop-setup deep link', () => {
  it.each(handoffGolden.setup)(
    'navigates to the exact link of the previous builder for $emailParam',
    async ({ emailParam, authorizationToken, href }) => {
      navigation.searchParams = new URLSearchParams({ email: emailParam })
      api.createDesktopAuthorization.mockResolvedValue({ authorizationToken })

      render(<DesktopSetupPage />)
      fireEvent.change(screen.getByPlaceholderText('Your password'), {
        target: { value: 'correct horse' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Authorize desktop setup' }))

      await waitFor(() => expect(location.href).toBe(href))
      expect(api.createDesktopAuthorization).toHaveBeenCalledWith('correct horse')
    }
  )
})
