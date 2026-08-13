import { IconPaperclip } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  IconAdministrativeTrace,
  IconBroadcast,
  IconCable,
  IconFolder,
  IconGroupWork,
  IconInfrastructureTrace,
  IconKey,
  IconLlmPrices,
  IconModels,
  IconOutputs,
  IconRobot,
  IconRunReplay,
  IconSettings,
  IconStore,
  IconTokenBudgets,
  IconTraceDashboard,
  IconUsage,
  IconUsageHistory,
  IconUsers,
  IconWorkflow,
} from './icons'
import type { SidebarItem, SidebarTab } from './types'

export const SIDEBAR_TABS: Record<SidebarTab, SidebarItem> = {
  hosts: { label: 'Agents', href: CONTROL_ROUTES.agents.root, icon: <IconRobot /> },
  'mcp-servers': {
    label: 'Installed connectors',
    href: CONTROL_ROUTES.connectors.root,
    icon: <IconCable />,
  },
  contexts: { label: 'Contexts', href: CONTROL_ROUTES.contexts.root, icon: <IconGroupWork /> },
  cost: {
    label: 'Cost & Usage',
    href: CONTROL_ROUTES.costAndUsage.root,
    icon: <IconUsage />,
    children: [
      {
        label: 'Usage',
        href: CONTROL_ROUTES.costAndUsage.usage,
        icon: <IconUsageHistory />,
      },
      {
        label: 'Token Budgets',
        href: CONTROL_ROUTES.costAndUsage.tokenBudgets,
        icon: <IconTokenBudgets />,
      },
      {
        label: 'LLM Prices',
        href: CONTROL_ROUTES.costAndUsage.llmPrices,
        icon: <IconLlmPrices />,
      },
    ],
  },
  directories: {
    label: 'Files',
    href: CONTROL_ROUTES.agentFiles.root,
    icon: <IconFolder />,
    children: [
      {
        label: 'Global File System',
        href: CONTROL_ROUTES.globalFileSystem,
        icon: <IconPaperclip />,
      },
      {
        label: 'Agent Outputs',
        href: CONTROL_ROUTES.agentOutputs.root,
        icon: <IconOutputs />,
        matchPath: CONTROL_ROUTES.agentOutputs.base,
      },
    ],
  },
  'communication-channels': {
    label: 'External Channels',
    href: CONTROL_ROUTES.externalChannels.root,
    icon: <IconBroadcast />,
  },
  'llm-models': {
    label: 'LLM Models',
    href: CONTROL_ROUTES.llmModels.root,
    icon: <IconModels />,
  },
  'registry-catalog': {
    label: 'Marketplace',
    href: CONTROL_ROUTES.marketplace.connectors,
    icon: <IconStore />,
  },
  'workflow-recipes': {
    label: 'Installed plugins',
    href: CONTROL_ROUTES.plugins.root,
    icon: <IconWorkflow />,
  },
  'llm-secrets': { label: 'Secrets', href: CONTROL_ROUTES.secrets.llm, icon: <IconKey /> },
  traces: {
    label: 'Traces',
    href: CONTROL_ROUTES.traces.root,
    icon: <IconWorkflow />,
    hidden: true,
    children: [
      {
        label: 'Administrative',
        href: CONTROL_ROUTES.traces.administrative,
        icon: <IconAdministrativeTrace />,
      },
      {
        label: 'Dashboard',
        href: CONTROL_ROUTES.traces.operations,
        icon: <IconTraceDashboard />,
      },
      {
        label: 'Infrastructure',
        href: CONTROL_ROUTES.traces.infrastructure,
        icon: <IconInfrastructureTrace />,
      },
      {
        label: 'Run replay',
        href: CONTROL_ROUTES.traces.root,
        icon: <IconRunReplay />,
      },
    ],
  },
  'profile-admin': {
    label: 'Users & Teams',
    href: CONTROL_ROUTES.usersAndTeams.root,
    icon: <IconUsers />,
  },
  settings: { label: 'Settings', href: CONTROL_ROUTES.settings.ui, icon: <IconSettings /> },
}

export const SIDEBAR_TAB_ORDER: SidebarTab[] = [
  'hosts',
  'contexts',
  'registry-catalog',
  'cost',
  'communication-channels',
  'directories',
  'mcp-servers',
  'workflow-recipes',
  'llm-models',
  'llm-secrets',
  'profile-admin',
  'traces',
  'settings',
]
