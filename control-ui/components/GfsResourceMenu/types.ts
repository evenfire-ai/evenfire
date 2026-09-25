export interface GfsResourceMenuProps {
  downloading?: boolean
  onCopyLink: () => void
  onDelete: () => void
  onDownload?: () => void
  onManage?: () => void
  onMove?: () => void
  /** Open a pasted EvenDrive link (jump-to-resource flow). Present on the
   *  folder menus shared between parent-view rows and breadcrumb crumbs. */
  onOpenLink?: () => void
  onPreview?: () => void
  onRename: () => void
  onReplace?: (file: File) => void
  resourceName: string
  resourceUri: string
}
