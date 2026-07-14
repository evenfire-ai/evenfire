export interface SharedFilesystemSummary {
  name: string
  mountPath: string
  phase: string | null
  pvcName: string | null
  message: string | null
}

export interface SharedFileDirEntry {
  name: string
  kind: 'file' | 'directory' | 'other'
  size: number
  mtime: string
}

export interface SharedFilesListState {
  loading: boolean
  loaded: boolean
  error: string | null
  items: SharedFilesystemSummary[] | null
}

export interface SharedFilesDirectoryState {
  loading: boolean
  loaded: boolean
  error: string | null
  entries: SharedFileDirEntry[]
  truncated: boolean
}
