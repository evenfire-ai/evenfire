export interface GfsResourceMenuProps {
  createShareDisabled?: boolean
  downloading?: boolean
  onCopyLink: () => void
  onCreateShare?: () => void
  onDelete: () => void
  onDownload?: () => void
  onManage?: () => void
  onPreview?: () => void
  onRename: () => void
  onReplace?: (file: File) => void
  resourceName: string
  resourceUri: string
}
