import type { GfsAgentSubjectOption } from '@/gfs/delegation.types'

export interface GfsAgentAccessSectionProps {
  agents: GfsAgentSubjectOption[]
  agentsLoading?: boolean
  agentsError?: string | null
  /** Directories offer the inherit toggle (default ON); files never send inherit. */
  isDirectory: boolean
  /** subjectKeys are `host:`-prefixed canonical subject ids (`host:1st:<ns>/<name>`). */
  onGrantAgents: (subjectKeys: string[], bits: string[], inherit: boolean) => Promise<void>
}
