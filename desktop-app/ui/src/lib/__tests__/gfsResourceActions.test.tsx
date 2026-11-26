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
        moveApplicable: true,
        previewable: true,
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
        moveApplicable: true,
        previewable: true,
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
        'open-route': handler(),
        rename: handler(),
        move: handler(),
        'new-folder': handler(),
        'upload-file': handler(),
        share: handler(),
        'copy-content': handler(),
        delete: handler(),
      },
      moveApplicable: true,
      previewable: true,
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
      'share',
      'copy-link',
      'rename',
      'move',
      'copy-content',
      'delete',
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
    expect(actions.find(action => action.id === 'copy-content')?.disabledReason).toBeUndefined()
    expect(actions.find(action => action.id === 'delete')).toMatchObject({
      disabled: true,
      disabledReason: "Delete isn't available",
    })

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
      moveApplicable: false,
      previewable: false,
      canReplace: true,
    })
    const menuAction = getGfsMenuActions(actions).find(action => action.id === 'replace')

    expect(menuAction).toMatchObject({ id: 'replace', label: 'Replace file', menu: true })
    menuAction?.run(undefined, { requestFileSelection })
    expect(requestFileSelection).toHaveBeenCalledOnce()
    menuAction?.run(file)
    expect(replace).toHaveBeenCalledWith(file)
  })

  it('offers an applicable action it may not run, disabled with a neutral reason', () => {
    const handlers = allHandlers()
    const folder = buildGfsResourceActions({
      kind: 'directory',
      uri: resourceUri,
      handlers,
      moveApplicable: true,
      previewable: false,
      canOpenFolder: true,
    })
    const byId = Object.fromEntries(folder.map(action => [action.id, action]))
    expect(getGfsMenuActions(folder).map(action => action.id)).toEqual([
      'share',
      'copy-link',
      'open-folder',
      'rename',
      'move',
      'new-folder',
      'upload-file',
      'download-zip',
      'delete',
    ])
    expect(
      ['share', 'rename', 'move', 'new-folder', 'upload-file', 'download-zip', 'delete'].map(id => [
        id,
        byId[id]?.disabled,
        byId[id]?.disabledReason,
      ])
    ).toEqual([
      ['share', true, "Share isn't available"],
      ['rename', true, "Rename isn't available"],
      ['move', true, "Move to isn't available"],
      ['new-folder', true, "New folder isn't available"],
      ['upload-file', true, "Upload file isn't available"],
      ['download-zip', true, "Download as zip isn't available"],
      ['delete', true, "Delete isn't available"],
    ])
    expect(byId['copy-link']).toMatchObject({ disabled: false })
    expect(byId['open-folder']).toMatchObject({ disabled: false })
    expect(byId['copy-link']?.disabledReason).toBeUndefined()
  })

  it('never reaches the handler of a disabled action', () => {
    const handlers = allHandlers()
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: resourceUri,
      handlers,
      moveApplicable: true,
      previewable: true,
      canRename: true,
      mutating: true,
    })
    for (const action of actions) action.run()
    // Not permitted, or permitted but held back by the in-flight change.
    for (const id of ['share', 'rename', 'move', 'preview', 'download', 'replace', 'delete']) {
      expect(handlers[id as keyof typeof handlers]).not.toHaveBeenCalled()
    }
    expect(handlers['copy-link']).toHaveBeenCalledTimes(1)
  })

  it('names the missing read access on read actions of an unreadable resource', () => {
    const file = buildGfsResourceActions({
      kind: 'file',
      uri: resourceUri,
      handlers: allHandlers(),
      moveApplicable: false,
      previewable: true,
      readable: false,
    })
    const folder = buildGfsResourceActions({
      kind: 'directory',
      uri: resourceUri,
      handlers: allHandlers(),
      moveApplicable: false,
      previewable: false,
      readable: false,
    })
    const reason = (actions: typeof file, id: string) =>
      actions.find(action => action.id === id)?.disabledReason
    expect(reason(file, 'preview')).toBe("You don't have read access to this file")
    expect(reason(file, 'download')).toBe("You don't have read access to this file")
    expect(reason(folder, 'download-zip')).toBe("You don't have read access to this folder")
    // Only reads name the read access; the rest keep the neutral reason.
    expect(reason(file, 'rename')).toBe("Rename isn't available")
  })

  it('gives the permission reason when an action is also held back by an in-flight change', () => {
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: resourceUri,
      handlers: allHandlers(),
      moveApplicable: true,
      previewable: false,
      canRename: true,
      canDelete: false,
      mutating: true,
    })
    expect(actions.find(action => action.id === 'delete')).toMatchObject({
      disabled: true,
      disabledReason: "Delete isn't available",
    })
    const rename = actions.find(action => action.id === 'rename')
    expect(rename?.disabled).toBe(true)
    expect(rename?.disabledReason).toBeUndefined()
  })

  it('leaves out what does not apply, whatever the permissions', () => {
    const file = buildGfsResourceActions({
      kind: 'file',
      uri: resourceUri,
      handlers: allHandlers(),
      moveApplicable: false,
      previewable: false,
      canMove: true,
      canPreview: true,
      canCreateFolder: true,
      canUpload: true,
      canDownloadZip: true,
      canOpenFolder: true,
    })
    const ids = file.map(action => action.id)
    for (const id of [
      'move',
      'preview',
      'new-folder',
      'upload-file',
      'download-zip',
      'open-folder',
    ]) {
      expect(ids).not.toContain(id)
    }
    expect(ids).toContain('download')
  })
})
