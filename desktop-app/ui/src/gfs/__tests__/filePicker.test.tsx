// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { buildGfsResourceDeepLink, buildGfsResourceWebLink } from '@clerum/desktop-app-links'
import { GfsFilePicker } from '../filePicker'

const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GfsFilePicker link contract', () => {
  it('resolves a Profile link through the supplied canonical URI without navigating its host', async () => {
    const onOpen = vi.fn(async () => true)
    const onOpened = vi.fn()
    const openWindow = vi.spyOn(window, 'open')
    render(<GfsFilePicker onOpen={onOpen} onOpened={onOpened} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: buildGfsResourceWebLink('https://another-env.example', resourceUri) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(resourceUri))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpened).toHaveBeenCalledOnce()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('accepts the desktop handoff producer and gives it only the canonical target', async () => {
    const onOpen = vi.fn(async () => undefined)
    const onOpened = vi.fn()
    render(<GfsFilePicker onOpen={onOpen} onOpened={onOpened} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: buildGfsResourceDeepLink(resourceUri) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(resourceUri))
    expect(onOpened).toHaveBeenCalledOnce()
  })

  it('keeps malformed Profile URLs in the dialog and does not attempt resolution', async () => {
    const onOpen = vi.fn()
    const onOpened = vi.fn()
    render(<GfsFilePicker onOpen={onOpen} onOpened={onOpened} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), {
      target: { value: `https://evil.example/open/files?uri=${encodeURIComponent(resourceUri)}#x` },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    expect(
      await screen.findByText('Enter a valid EvenDrive link or canonical GFS URI.')
    ).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
    expect(onOpened).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'URL' })).toBeTruthy()
  })
})
