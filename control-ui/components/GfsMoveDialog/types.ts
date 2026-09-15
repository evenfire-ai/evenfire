export type MoveFolder = {
  resourceId: string
  name: string
  kind: string
  /** Present on browser rows so a no-op move to the current parent is refused. */
  parentResourceId?: string | null
}

export type MoveCrumb = {
  id: string | null
  name: string
}

export type MoveTreePage = {
  rootResourceId?: string
  items: MoveFolder[]
  nextCursor: string | null
}

export type SelectedMoveDestination = Pick<MoveFolder, 'resourceId' | 'name'>

export type GfsMoveDialogProps = {
  target: MoveFolder
  initialCrumbs: MoveCrumb[]
  busy?: boolean
  onClose: () => void
  onMove: (destinationId: string, destinationName: string) => Promise<void>
}

export type MoveTreeFolderProps = {
  ancestors: ReadonlySet<string>
  expandedIds: ReadonlySet<string>
  folder: MoveFolder
  level: number
  selected: SelectedMoveDestination | null
  targetId: string
  onSelect: (folder: MoveFolder) => void
  onToggle: (folderId: string) => void
}
