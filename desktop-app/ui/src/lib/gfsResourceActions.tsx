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
  IconShare,
  IconTrash,
  IconUpload,
} from '@components/SidebarNav/icons'
import { readAccessReason, unavailableReason } from '@constants/gfsActionCopy'

export type GfsResourceKind = 'directory' | 'file'
export type GfsResourceActionId =
  | 'refresh'
  | 'copy-link'
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
  /** Why a disabled action cannot run, shown as its tooltip. */
  disabledReason?: string
  loading: boolean
  run: GfsResourceActionHandler
}

export type GfsResourceActionHandlers = Partial<
  Record<GfsResourceActionId, GfsResourceActionHandler>
>

export type GfsResourceActionOptions = {
  kind: GfsResourceKind
  uri: string
  handlers: GfsResourceActionHandlers
  /**
   * Whether Move applies to this resource at all (it has a parent folder).
   * Required so a surface cannot leave Move greyed out where it never applies.
   */
  moveApplicable: boolean
  /**
   * Whether the file's format has a preview. Required so a format without one
   * is left out instead of greyed out; ignored for folders.
   */
  previewable: boolean
  /** The listing's read flag; an explicit `false` names the cause on read actions. */
  readable?: boolean
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
  /** False leaves the action out: it does not apply to this resource. */
  applicable: boolean
  /** False offers the action disabled, with a reason, and makes its run inert. */
  permitted?: boolean
  /** A permitted action can still be inert for another cause (no reason given). */
  disabled?: boolean
  /** Reads name the unreadable listing as their cause. */
  read?: boolean
  loading?: boolean
}

const noop: GfsResourceActionHandler = () => {}

export function buildGfsResourceActions(options: GfsResourceActionOptions): GfsResourceAction[] {
  const mutating = options.mutating ?? false
  const isFile = options.kind === 'file'
  const isDirectory = options.kind === 'directory'
  const definitions: ActionDefinition[] = [
    {
      id: 'refresh',
      label: 'Refresh',
      icon: <IconRefresh />,
      menu: false,
      applicable: true,
      disabled: mutating || (options.refreshing ?? false),
      loading: options.refreshing ?? false,
    },
    {
      id: 'share',
      label: 'Share',
      icon: <IconShare />,
      menu: true,
      applicable: true,
      permitted: Boolean(options.canShare),
      disabled: mutating,
    },
    {
      id: 'copy-link',
      label: 'Copy link',
      icon: <IconCopy />,
      menu: true,
      applicable: true,
    },
    {
      id: 'open-route',
      label: 'Open link',
      icon: <IconOpenRoute />,
      menu: false,
      applicable: true,
    },
    {
      id: 'open-folder',
      label: 'Open folder',
      icon: <IconContexts />,
      menu: true,
      applicable: isDirectory && Boolean(options.canOpenFolder),
    },
    {
      id: 'rename',
      label: 'Rename',
      icon: <IconEdit />,
      menu: true,
      applicable: true,
      permitted: Boolean(options.canRename),
      disabled: mutating,
    },
    {
      id: 'move',
      label: 'Move to',
      icon: <IconContexts />,
      menu: true,
      applicable: options.moveApplicable,
      permitted: Boolean(options.canMove),
      disabled: mutating,
    },
    {
      id: 'new-folder',
      label: 'New folder',
      icon: <IconPlus />,
      menu: true,
      applicable: isDirectory,
      permitted: Boolean(options.canCreateFolder),
      disabled: mutating,
    },
    {
      id: 'upload-file',
      label: 'Upload file',
      icon: <IconUpload />,
      menu: true,
      applicable: isDirectory,
      permitted: Boolean(options.canUpload),
      disabled: mutating,
    },
    {
      id: 'copy-content',
      label: 'Copy content',
      icon: <IconCopyContent />,
      menu: true,
      applicable: isFile,
      // Inert until the preview body hands over its copier. That is not a
      // permission, so it carries no tooltip.
      disabled: !options.canCopyContent,
    },
    {
      id: 'preview',
      label: 'Preview',
      icon: <IconEye />,
      menu: true,
      applicable: isFile && options.previewable,
      permitted: Boolean(options.canPreview),
      read: true,
    },
    {
      id: 'download',
      label: 'Download',
      icon: <IconDownload />,
      menu: true,
      applicable: isFile,
      permitted: Boolean(options.canDownload),
      read: true,
    },
    {
      id: 'download-zip',
      label: 'Download as zip',
      icon: <IconDownload />,
      menu: true,
      applicable: isDirectory,
      permitted: Boolean(options.canDownloadZip),
      read: true,
    },
    {
      id: 'replace',
      label: 'Replace file',
      icon: <IconUpload />,
      menu: true,
      applicable: isFile,
      permitted: Boolean(options.canReplace),
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: <IconTrash />,
      menu: true,
      applicable: true,
      permitted: Boolean(options.canDelete),
      disabled: mutating,
    },
  ]

  return definitions.flatMap(definition => {
    const handler = options.handlers[definition.id]
    if (!definition.applicable || !handler) return []
    const permitted = definition.permitted ?? true
    const disabled = !permitted || (definition.disabled ?? false)
    const disabledReason = permitted
      ? undefined
      : definition.read && options.readable === false
        ? readAccessReason(options.kind)
        : unavailableReason(definition.label)
    return [
      {
        id: definition.id,
        label: definition.label,
        icon: definition.icon,
        targetUri: options.uri,
        menu: definition.menu,
        disabled,
        ...(disabledReason ? { disabledReason } : {}),
        loading: definition.loading ?? false,
        // An inert action never reaches its handler, whatever renders it.
        run: disabled ? noop : handler,
      },
    ]
  })
}

export function getGfsMenuActions(actions: GfsResourceAction[]): GfsResourceAction[] {
  return actions.filter(action => action.menu)
}
