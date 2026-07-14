export interface ControlAdminsPanelProps {
  highlightedAdminId?: string
  searchInput?: string
  refreshKey?: number
  onCountsChange?: (counts: { admins: number; invitations: number }) => void
  onLoadingChange?: (loading: boolean) => void
}
