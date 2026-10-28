// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'
import { GfsResourceMenu } from './index'

describe('GfsResourceMenu', () => {
  beforeEach(installAntdDomEnvironment)

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders Ant Design actions, retains the Share submenu and invokes its existing callback', async () => {
    const onManage = vi.fn()
    const onCopyLink = vi.fn()
    render(
      <GfsResourceMenu
        onCopyLink={onCopyLink}
        onDelete={vi.fn()}
        onManage={onManage}
        onPreview={vi.fn()}
        onReplace={vi.fn()}
        resourceName="report.txt"
      />
    )

    const trigger = screen.getByRole('button', { name: 'Options for report.txt' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(trigger)

    const menu = await screen.findByRole('menu', { name: 'Actions for report.txt' })
    expect(within(menu).getByRole('menuitem', { name: 'Preview' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Replace file' })).toBeTruthy()
    expect(within(menu).queryByRole('menuitem', { name: 'Copy link' })).toBeNull()

    const shareItem = within(menu).getByRole('menuitem', { name: 'Share' })
    fireEvent.mouseEnter(shareItem)
    await screen.findByRole('menuitem', { name: 'Copy link' })
    const menus = screen.getAllByRole('menu')
    expect(menus).toHaveLength(2)
    const shareMenu = menus[1]!
    expect(within(shareMenu).getByRole('menuitem', { name: 'Share' })).toBeTruthy()
    expect(within(shareMenu).getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()

    fireEvent.mouseEnter(within(menu).getByRole('menuitem', { name: 'Preview' }))
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
    await waitFor(() => expect(onManage).toHaveBeenCalledOnce())
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(onCopyLink).not.toHaveBeenCalled()
  })

  it('offers Download as zip independently from Download for folders', async () => {
    const onDownloadZip = vi.fn()
    render(
      <GfsResourceMenu resourceName="Assets" onDownload={undefined} onDownloadZip={onDownloadZip} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Options for Assets' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Assets' })
    const zipItem = within(menu).getByRole('menuitem', { name: 'Download as zip' })
    expect(within(menu).queryByRole('menuitem', { name: /^Download$/ })).toBeNull()

    fireEvent.click(zipItem)
    expect(onDownloadZip).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Options for Assets' }).getAttribute('aria-expanded')
      ).toBe('false')
    )
  })

  it('keeps the popup attached to the Files surface when the sidebar changes width', async () => {
    const { container } = render(
      <section data-gfs-browser="true">
        <GfsResourceMenu resourceName="Shared with me" onOpenGfsLink={vi.fn()} />
      </section>
    )
    const surface = container.querySelector('[data-gfs-browser="true"]')
    expect(surface).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Options for Shared with me' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Shared with me' })
    expect(menu.closest('[data-gfs-browser="true"]')).toBe(surface)

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(menu.closest('[data-gfs-browser="true"]')).toBe(surface)
  })

  it('notifies lazy action consumers and returns focus after Escape', async () => {
    const onOpenChange = vi.fn()
    render(
      <GfsResourceMenu
        onOpenChange={onOpenChange}
        onOpenGfsLink={vi.fn()}
        resourceName="Shared with me"
      />
    )

    const trigger = screen.getByRole('button', { name: 'Options for Shared with me' })
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Actions for Shared with me' })
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(true))

    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false))
    expect(document.activeElement).toBe(trigger)
  })
})
