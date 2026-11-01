// @vitest-environment jsdom
import { isValidElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, within } from '@testing-library/react'
import { GfsResourceTitlebarActions } from '@components/GfsResourceTitlebarActions'
import { buildGfsResourceActions, getGfsMenuActions } from '../gfsResourceActions'

const handler = () => vi.fn()
const allHandlers = () => ({
  refresh: handler(),
  'copy-link': handler(),
  'copy-route': handler(),
  'open-route': handler(),
  rename: handler(),
  move: handler(),
  'new-folder': handler(),
  'upload-file': handler(),
  share: handler(),
  'copy-content': handler(),
  preview: handler(),
  download: handler(),
  'download-zip': handler(),
  replace: handler(),
  'open-folder': handler(),
  delete: handler(),
})

const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'

afterEach(cleanup)

describe('GFS resource action model', () => {
  it('keeps the canonical folder and file menu order with valid historical icons', () => {
    const folderActions = getGfsMenuActions(
      buildGfsResourceActions({
        kind: 'directory',
        uri: resourceUri,
        handlers: allHandlers(),
        canRename: true,
        canMove: true,
        canCreateFolder: true,
        canUpload: true,
        canDownloadZip: true,
        canShare: true,
        canOpenFolder: true,
        canDelete: true,
      })
    )
    const fileActions = getGfsMenuActions(
      buildGfsResourceActions({
        kind: 'file',
        uri: resourceUri,
        handlers: allHandlers(),
        canRename: true,
        canMove: true,
        canShare: true,
        canCopyContent: true,
        canPreview: true,
        canDownload: true,
        canReplace: true,
        canDelete: true,
      })
    )

    expect(folderActions.map(action => action.id)).toEqual([
      'share',
      'copy-link',
      'copy-route',
      'open-folder',
      'rename',
      'move',
      'new-folder',
      'upload-file',
      'download-zip',
      'delete',
    ])
    expect(fileActions.map(action => action.id)).toEqual([
      'share',
      'copy-link',
      'copy-route',
      'rename',
      'move',
      'copy-content',
      'preview',
      'download',
      'replace',
      'delete',
    ])
    for (const actions of [folderActions, fileActions]) {
      for (const action of actions) {
        expect(isValidElement(action.icon)).toBe(true)
      }
      expect(actions.every(action => action.targetUri === resourceUri)).toBe(true)
    }
    const moveIcon = folderActions.find(action => action.id === 'move')?.icon
    const openFolderIcon = folderActions.find(action => action.id === 'open-folder')?.icon
    expect(isValidElement(moveIcon)).toBe(true)
    expect(isValidElement(openFolderIcon)).toBe(true)
    if (isValidElement(moveIcon) && isValidElement(openFolderIcon)) {
      expect(moveIcon.type).toBe(openFolderIcon.type)
    }
  })

  it('keeps busy Refresh on the titlebar and excludes it from resource menus', () => {
    const descriptors = buildGfsResourceActions({
      kind: 'file',
      uri: resourceUri,
      handlers: {
        refresh: handler(),
        'copy-link': handler(),
        'copy-route': handler(),
        'open-route': handler(),
        rename: handler(),
        move: handler(),
        'new-folder': handler(),
        'upload-file': handler(),
        share: handler(),
        'copy-content': handler(),
        delete: handler(),
      },
      canRename: false,
      canMove: true,
      canCreateFolder: true,
      canUpload: true,
      canShare: false,
      canCopyContent: false,
      canDelete: false,
      mutating: true,
      refreshing: true,
    })
    const actions = getGfsMenuActions(descriptors)

    expect(actions.map(action => action.id)).toEqual([
      'copy-link',
      'copy-route',
      'move',
      'copy-content',
    ])
    expect(descriptors.find(action => action.id === 'refresh')).toMatchObject({
      menu: false,
      disabled: true,
      loading: true,
    })
    expect(actions.some(action => ['refresh', 'open-route'].includes(action.id))).toBe(false)
    expect(actions.find(action => action.id === 'copy-content')).toMatchObject({
      disabled: true,
    })
    expect(actions.some(action => action.id === 'delete')).toBe(false)

    const target = document.createElement('div')
    document.body.appendChild(target)
    const onRefresh = handler()
    render(
      <GfsResourceTitlebarActions
        target={target}
        onRefresh={onRefresh}
        refreshing
        onCopyLink={handler()}
        onOpenLink={handler()}
      />
    )
    const toolbar = within(target).getByRole('toolbar', { name: 'EvenDrive actions' })
    const refreshButton = within(toolbar).getByRole('button', { name: 'Refresh' })
    expect((refreshButton as HTMLButtonElement).disabled).toBe(true)
    expect(refreshButton.parentElement?.getAttribute('title')).toBe('Refreshing EvenDrive')
    expect(within(toolbar).getByRole('button', { name: 'Copy link' })).toBeTruthy()
    expect(within(toolbar).getByRole('button', { name: 'Open link' })).toBeTruthy()
    target.remove()
  })

  it('keeps replacement execution in the shared menu descriptor', () => {
    const file = new File(['replacement'], 'replacement.txt')
    const requestFileSelection = vi.fn()
    const replace = vi.fn((selectedFile, context) => {
      if (selectedFile) return
      context?.requestFileSelection?.()
    })
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: resourceUri,
      handlers: { replace },
      canReplace: true,
    })
    const menuAction = getGfsMenuActions(actions).find(action => action.id === 'replace')

    expect(menuAction).toMatchObject({ id: 'replace', label: 'Replace file', menu: true })
    menuAction?.run(undefined, { requestFileSelection })
    expect(requestFileSelection).toHaveBeenCalledOnce()
    menuAction?.run(file)
    expect(replace).toHaveBeenCalledWith(file)
  })
})
