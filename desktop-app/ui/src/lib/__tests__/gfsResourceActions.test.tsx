import { isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
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
  replace: handler(),
  'open-folder': handler(),
  delete: handler(),
})

const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'

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

  it('omits unsupported or unauthorized operations and retains busy feedback in menus', () => {
    const actions = getGfsMenuActions(
      buildGfsResourceActions({
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
    )

    expect(actions.map(action => action.id)).toEqual([
      'copy-link',
      'copy-route',
      'move',
      'copy-content',
    ])
    expect(actions[0]).toMatchObject({ disabled: true, loading: true })
    expect(actions.find(action => action.id === 'copy-content')).toMatchObject({
      disabled: true,
    })
    expect(actions.some(action => action.id === 'delete')).toBe(false)
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
