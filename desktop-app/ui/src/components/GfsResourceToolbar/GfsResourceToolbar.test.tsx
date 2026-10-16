// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { buildGfsResourceActions } from '@lib/gfsResourceActions'
import { GfsResourceToolbar } from '.'

afterEach(cleanup)

function directoryActions(run: () => void) {
  return buildGfsResourceActions({
    kind: 'directory',
    uri: 'gfs://main/0123456789abcdef0123456789abcdef',
    handlers: {
      refresh: run,
      'copy-link': run,
      'copy-route': run,
      'open-route': run,
      rename: run,
      move: run,
      'new-folder': run,
      'upload-file': run,
      share: run,
      delete: run,
    },
    canRename: true,
    canMove: true,
    canCreateFolder: true,
    canUpload: true,
    canShare: true,
    canDelete: true,
  })
}

describe('GfsResourceToolbar', () => {
  it('renders every eligible folder action in the title bar with hover and focus tooltips', () => {
    const run = vi.fn()
    const titlebarLeadingRoot = document.createElement('div')
    document.body.appendChild(titlebarLeadingRoot)
    const view = render(
      <GfsResourceToolbar actions={directoryActions(run)} portalTarget={titlebarLeadingRoot} />
    )

    try {
      const toolbar = within(titlebarLeadingRoot).getByRole('toolbar', {
        name: 'EvenDrive actions',
      })
      expect(toolbar.classList.contains('window-titlebar__leading-actions')).toBe(true)
      expect(
        within(toolbar)
          .getAllByRole('button')
          .map(button => button.getAttribute('aria-label'))
      ).toEqual([
        'Refresh',
        'Share',
        'Copy link',
        'Copy route',
        'Open route',
        'Rename',
        'Move to',
        'New folder',
        'Upload file',
        'Delete',
      ])

      const refresh = within(toolbar).getByRole('button', { name: 'Refresh' })
      expect(refresh.getAttribute('title')).toBeNull()
      fireEvent.mouseEnter(refresh)
      const hoverTooltip = within(toolbar).getByRole('tooltip')
      expect(hoverTooltip.textContent).toBe('Refresh')
      expect(refresh.getAttribute('aria-describedby')).toBe(hoverTooltip.id)

      fireEvent.mouseLeave(refresh)
      expect(within(toolbar).queryByRole('tooltip')).toBeNull()
      fireEvent.focus(refresh)
      expect(within(toolbar).getByRole('tooltip').textContent).toBe('Refresh')

      expect(
        within(toolbar)
          .getByRole('button', { name: 'Delete' })
          .classList.contains('ui-icon-button--danger')
      ).toBe(true)

      fireEvent.click(refresh)
      expect(run).toHaveBeenCalledOnce()
      expect(view.container.querySelector('.da-gfs-resource-toolbar')).toBeNull()
    } finally {
      view.unmount()
      titlebarLeadingRoot.remove()
    }
  })
})
