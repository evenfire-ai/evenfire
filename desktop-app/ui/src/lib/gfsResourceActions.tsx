import type { ReactNode } from 'react'
import {
  IconContexts,
  IconCopy,
  IconCopyContent,
  IconDownload,
  IconEdit,
  IconEye,
  IconOpenRoute,
  IconPlus,
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
  | 'download-zip'
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
  /** Navigation target for parent-relative actions such as Move on unreadable rows. */
  navigationUri?: string | null
  /** Exact row identity when the action must be resolved through its parent. */
  targetResource?: {
    resourceId: string
    name: string
    kind: GfsResourceKind
    version: number
    parentResourceId: string | null
  }
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
  canDownloadZip?: boolean
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
      menu: false,
      eligible: Boolean(options.handlers.refresh),
      disabled: mutating || (options.refreshing ?? false),
      loading: options.refreshing ?? false,
    },
    {
      id: 'share',
      label: 'Share',
      icon: <IconShare />,
      menu: true,
      eligible: Boolean(options.canShare && options.handlers.share),
      disabled: mutating,
    },
    {
      id: 'copy-link',
      label: 'Copy link',
      icon: <IconCopy />,
      menu: true,
      eligible: Boolean(options.handlers['copy-link']),
    },
    {
      id: 'copy-route',
      label: options.kind === 'directory' ? 'Copy folder ID' : 'Copy file ID',
      icon: <IconRoute />,
      menu: true,
      eligible: Boolean(options.handlers['copy-route']),
    },
    {
      id: 'open-route',
      label: 'Open link',
      icon: <IconOpenRoute />,
      menu: false,
      eligible: Boolean(options.handlers['open-route']),
    },
    {
      id: 'open-folder',
      label: 'Open folder',
      icon: <IconContexts />,
      menu: true,
      eligible: Boolean(
        options.kind === 'directory' && options.canOpenFolder && options.handlers['open-folder']
      ),
    },
    {
      id: 'rename',
      label: 'Rename',
      icon: <IconEdit />,
      menu: true,
      eligible: Boolean(options.canRename && options.handlers.rename),
      disabled: mutating,
    },
    {
      id: 'move',
      label: 'Move to',
      icon: <IconContexts />,
      menu: true,
      eligible: Boolean(options.canMove && options.handlers.move),
      disabled: mutating,
    },
    {
      id: 'new-folder',
      label: 'New folder',
      icon: <IconPlus />,
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
      menu: true,
      eligible: Boolean(
        options.kind === 'directory' && options.canUpload && options.handlers['upload-file']
      ),
      disabled: mutating,
    },
    {
      id: 'copy-content',
      label: 'Copy content',
      icon: <IconCopyContent />,
      menu: true,
      eligible: Boolean(options.kind === 'file' && options.handlers['copy-content']),
      disabled: !options.canCopyContent,
    },
    {
      id: 'preview',
      label: 'Preview',
      icon: <IconEye />,
      menu: true,
      eligible: Boolean(options.kind === 'file' && options.canPreview && options.handlers.preview),
    },
    {
      id: 'download',
      label: 'Download',
      icon: <IconDownload />,
      menu: true,
      eligible: Boolean(
        options.kind === 'file' && options.canDownload && options.handlers.download
      ),
    },
    {
      id: 'download-zip',
      label: 'Download as zip',
      icon: <IconDownload />,
      menu: true,
      eligible: Boolean(
        options.kind === 'directory' && options.canDownloadZip && options.handlers['download-zip']
      ),
    },
    {
      id: 'replace',
      label: 'Replace file',
      icon: <IconUpload />,
      menu: true,
      eligible: Boolean(options.kind === 'file' && options.canReplace && options.handlers.replace),
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: <IconTrash />,
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
        menu: definition.menu,
        disabled: definition.disabled ?? false,
        loading: definition.loading ?? false,
        run,
      },
    ]
  })
}

export function getGfsMenuActions(actions: GfsResourceAction[]): GfsResourceAction[] {
  return actions.filter(action => action.menu)
}
