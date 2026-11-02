// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { buildGfsResourceActions } from '@lib/gfsResourceActions'
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
        <GfsResourceMenu resourceName="Shared with me" />
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
    render(<GfsResourceMenu onOpenChange={onOpenChange} resourceName="Shared with me" />)

    const trigger = screen.getByRole('button', { name: 'Options for Shared with me' })
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Actions for Shared with me' })
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(true))

    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false))
    expect(document.activeElement).toBe(trigger)
  })

  it('runs shared action descriptors from the Ant Design Share submenu', async () => {
    const refresh = vi.fn()
    const share = vi.fn()
    const copyLink = vi.fn()
    const copyRoute = vi.fn()
    const actions = buildGfsResourceActions({
      kind: 'directory',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      handlers: { refresh, share, 'copy-link': copyLink, 'copy-route': copyRoute },
      canShare: true,
    })
    render(<GfsResourceMenu actions={actions} resourceName="Reports" />)

    fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Reports' })
    const shareItem = within(menu).getByRole('menuitem', { name: 'Share' })
    fireEvent.mouseEnter(shareItem)
    await screen.findByRole('menuitem', { name: 'Copy link' })
    const shareMenu = screen.getAllByRole('menu')[1]
    expect(shareMenu).toBeTruthy()
    expect(within(shareMenu!).getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()
    expect(within(shareMenu!).getByRole('menuitem', { name: 'Copy folder ID' })).toBeTruthy()
    fireEvent.click(within(shareMenu!).getByRole('menuitem', { name: 'Share' }))

    await waitFor(() => expect(share).toHaveBeenCalledOnce())
    expect(refresh).not.toHaveBeenCalled()
    expect(copyLink).not.toHaveBeenCalled()
    expect(copyRoute).not.toHaveBeenCalled()
  })

  it('passes the selected replacement file through its shared action descriptor', async () => {
    const replace = vi.fn((file?: File, context?: { requestFileSelection?: () => void }) => {
      if (!file) context?.requestFileSelection?.()
    })
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      handlers: { replace },
      canReplace: true,
    })
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    render(<GfsResourceMenu actions={actions} resourceName="report.txt" />)

    fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Replace file' }))

    expect(replace).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ requestFileSelection: expect.any(Function) })
    )
    expect(inputClick).toHaveBeenCalledOnce()

    const selectedFile = new File(['replacement'], 'replacement.txt')
    fireEvent.change(screen.getByLabelText('Replace report.txt'), {
      target: { files: [selectedFile] },
    })
    expect(replace).toHaveBeenLastCalledWith(selectedFile)
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Options for report.txt' })
    )
  })
})
