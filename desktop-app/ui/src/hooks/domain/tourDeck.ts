import { TOUR_MAX_MIDDLE_STEPS } from '@constants/tour'

export type TourStepId =
  | 'welcome'
  | 'agents'
  | 'approvals'
  | 'mcpServers'
  | 'scope'
  | 'apps'
  | 'plugins'
  | 'files'
  | 'desktop'
  | 'handoff'

/**
 * What this user actually has in this environment.
 *
 * Every field comes from data the authenticated app already fetched. A source
 * that has not resolved is `undefined`, which reads as absent — the tour shows
 * fewer steps rather than waiting, because a thin honest tour beats a spinner.
 */
export interface TourCensus {
  agentNames: string[]
  contextIds: string[]
  /** Connector (MCP server) names per agent, from the access catalog. */
  mcpServersByAgent: Record<string, string[]>
  /** Undefined until the sandbox-UI app list resolves. */
  sandboxUiAppCount?: number
  /** Undefined until the workflow list resolves. */
  workflowCount?: number
  /** Undefined until an accessible-roots read resolves. */
  gfsRootCount?: number
}

function hasAnyConnector(census: TourCensus): boolean {
  return Object.values(census.mcpServersByAgent).some(servers => servers.length > 0)
}

/**
 * Middle-step candidates in canonical priority order. The first eligible three
 * are rendered, so the order here is the product decision about what matters
 * most when an environment qualifies for more steps than the tour will show.
 */
const MIDDLE_STEPS: ReadonlyArray<{ id: TourStepId; eligible: (census: TourCensus) => boolean }> = [
  { id: 'agents', eligible: c => c.agentNames.length > 0 },
  // Omitted when no agent has connectors: such an agent never asks for approval,
  // so describing approvals would promise a moment that cannot happen here.
  { id: 'approvals', eligible: hasAnyConnector },
  // Connectors, the file system and app interfaces all ship with every
  // deployment, so these are capabilities the user has rather than ones the
  // census has to discover. An empty file system is an empty inbox, not an
  // absent feature.
  { id: 'mcpServers', eligible: () => true },
  { id: 'files', eligible: () => true },
  { id: 'apps', eligible: () => true },
  // Falls to whoever has slots left — in practice a user with no agents, who
  // has fewer cards competing for the middle.
  { id: 'desktop', eligible: () => true },
  { id: 'scope', eligible: c => c.contextIds.length > 0 || hasAnyConnector(c) },
  { id: 'plugins', eligible: c => (c.workflowCount ?? 0) > 0 },
]

/**
 * Pick the tour for this environment: Welcome, the first eligible middle steps,
 * then Handoff — between three and six steps.
 *
 * Pure: no I/O, no hooks, no fetching. The caller passes what it already has.
 */
export function selectTourSteps(census: TourCensus): TourStepId[] {
  const middle: TourStepId[] = []
  for (const step of MIDDLE_STEPS) {
    if (middle.length >= TOUR_MAX_MIDDLE_STEPS) break
    if (step.eligible(census)) middle.push(step.id)
  }
  return ['welcome', ...middle, 'handoff']
}
