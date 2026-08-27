export type AppFindState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'results'; current: number; total: number }
  | { status: 'empty' }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }

export type SandboxCurrentContentSearchProps = {
  focusRequestId: number
  onClose: () => void
  onMove: (operation: 'next' | 'previous') => void
  onQueryChange: (query: string) => void
  query: string
  state: AppFindState
}
