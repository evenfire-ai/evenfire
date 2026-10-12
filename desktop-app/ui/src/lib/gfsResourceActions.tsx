import type { ReactNode } from 'react'
import {
  IconContexts,
  IconCopyContent,
  IconDownload,
  IconEdit,
  IconEye,
  IconFolderPlus,
  IconLink,
  IconMove,
  IconOpenRoute,
  IconRefresh,
  IconRoute,
  IconShare,
  IconTrash,
  IconUpload,
} from '@components/SidebarNav/icons'

export type GfsResourceKind = 'directory' | 'file'
export type GfsResourceActionId =
  | 'refresh'
  | 'copy-link'
  | 'copy-route'
  | 'open-route'
  | 'rename'
  | 'move'
  | 'new-folder'
  | 'upload-file'
  | 'share'
  | 'copy-content'
  | 'preview'
  | 'download'
  | 'replace'
  | 'open-folder'
  | 'delete'

export type GfsResourceActionContext = {
  requestFileSelection?: () => void
}

export type GfsResourceActionHandler = (file?: File, context?: GfsResourceActionContext) => void

export type GfsResourceAction = {
  id: GfsResourceActionId
  label: string
  icon: ReactNode
  targetUri: string
  toolbar: boolean
  menu: boolean
  disabled: boolean
  loading: boolean
  run: GfsResourceActionHandler
}

export type GfsResourceActionHandlers = Partial<
  Record<GfsResourceActionId, GfsResourceActionHandler>
>

export type GfsResourceActionRequest = {
  id: number
  targetUri: string
  actionId: GfsResourceActionId
  file?: File
}

export type GfsResourceActionOptions = {
  kind: GfsResourceKind
  uri: string
  handlers: GfsResourceActionHandlers
  canRename?: boolean
  canMove?: boolean
  canCreateFolder?: boolean
  canUpload?: boolean
  canShare?: boolean
  canCopyContent?: boolean
  canPreview?: boolean
  canDownload?: boolean
  canReplace?: boolean
  canOpenFolder?: boolean
  canDelete?: boolean
  mutating?: boolean
  refreshing?: boolean
}

type ActionDefinition = {
  id: GfsResourceActionId
  label: string
  icon: ReactNode
  toolbar: boolean
  menu: boolean
  eligible: boolean
  disabled?: boolean
  loading?: boolean
}

export function buildGfsResourceActions(options: GfsResourceActionOptions): GfsResourceAction[] {
  const mutating = options.mutating ?? false
  const definitions: ActionDefinition[] = [
    {
      id: 'refresh',
      label: 'Refresh',
      icon: <IconRefresh />,
      toolbar: true,
      menu: true,
      eligible: Boolean(options.handlers.refresh),
      disabled: mutating || (options.refreshing ?? false),
      loading: options.refreshing ?? false,
    },
    {
      id: 'copy-link',
      label: 'Copy link',
      icon: <IconLink />,
      toolbar: true,
      menu: true,
      eligible: Boolean(options.handlers['copy-link']),
    },
    {
      id: 'copy-route',
      label: 'Copy route',
      icon: <IconRoute />,
      toolbar: true,
      menu: true,
      eligible: Boolean(options.handlers['copy-route']),
    },
    {
      id: 'open-route',
      label: 'Open route',
      icon: <IconOpenRoute />,
      toolbar: true,
      menu: true,
      eligible: Boolean(options.handlers['open-route']),
    },
    {
      id: 'rename',
      label: 'Rename',
      icon: <IconEdit />,
      toolbar: true,
      menu: true,
      eligible: Boolean(options.canRename && options.handlers.rename),
      disabled: mutating,
    },
    {
      id: 'move',
      label: 'Move to',
      icon: <IconMove />,
      toolbar: true,
      menu: true,
      eligible: Boolean(options.canMove && options.handlers.move),
      disabled: mutating,
    },
    {
      id: 'new-folder',
      label: 'New folder',
      icon: <IconFolderPlus />,
      toolbar: true,
      menu: true,
      eligible: Boolean(
        options.kind === 'directory' && options.canCreateFolder && options.handlers['new-folder']
      ),
      disabled: mutating,
    },
    {
      id: 'upload-file',
      label: 'Upload file',
      icon: <IconUpload />,
      toolbar: true,
      menu: true,
      eligible: Boolean(
        options.kind === 'directory' && options.canUpload && options.handlers['upload-file']
      ),
      disabled: mutating,
    },
    {
      id: 'share',
      label: 'Share',
      icon: <IconShare />,
      toolbar: true,
      menu: true,
      eligible: Boolean(options.canShare && options.handlers.share),
      disabled: mutating,
    },
    {
      id: 'copy-content',
      label: 'Copy content',
      icon: <IconCopyContent />,
      toolbar: true,
      menu: true,
      eligible: Boolean(options.kind === 'file' && options.handlers['copy-content']),
      disabled: !options.canCopyContent,
    },
    {
      id: 'preview',
      label: 'Preview',
      icon: <IconEye />,
      toolbar: false,
      menu: true,
      eligible: Boolean(options.kind === 'file' && options.canPreview && options.handlers.preview),
    },
    {
      id: 'download',
      label: 'Download',
      icon: <IconDownload />,
      toolbar: false,
      menu: true,
      eligible: Boolean(
        options.kind === 'file' && options.canDownload && options.handlers.download
      ),
    },
    {
      id: 'replace',
      label: 'Replace file',
      icon: <IconUpload />,
      toolbar: false,
      menu: true,
      eligible: Boolean(options.kind === 'file' && options.canReplace && options.handlers.replace),
    },
    {
      id: 'open-folder',
      label: 'Open folder',
      icon: <IconContexts />,
      toolbar: false,
      menu: true,
      eligible: Boolean(
        options.kind === 'directory' && options.canOpenFolder && options.handlers['open-folder']
      ),
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: <IconTrash />,
      toolbar: false,
      menu: true,
      eligible: Boolean(options.canDelete && options.handlers.delete),
      disabled: mutating,
    },
  ]

  return definitions.flatMap(definition => {
    const run = options.handlers[definition.id]
    if (!definition.eligible || !run) return []
    return [
      {
        id: definition.id,
        label: definition.label,
        icon: definition.icon,
        targetUri: options.uri,
        toolbar: definition.toolbar,
        menu: definition.menu,
        disabled: definition.disabled ?? false,
        loading: definition.loading ?? false,
        run,
      },
    ]
  })
}

export function getGfsToolbarActions(actions: GfsResourceAction[]): GfsResourceAction[] {
  return actions.filter(action => action.toolbar)
}

export function getGfsMenuActions(actions: GfsResourceAction[]): GfsResourceAction[] {
  return actions.filter(action => action.menu)
}
