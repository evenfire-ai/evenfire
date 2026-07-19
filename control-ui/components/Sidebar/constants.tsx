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
  IconModelCatalog,
  IconModelDiscovery,
  IconModels,
  IconOutputs,
  IconPublish,
  IconRobot,
  IconRunReplay,
  IconSettings,
  IconSharedFiles,
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
    label: 'Connectors',
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
        label: 'LLM Prices',
        href: CONTROL_ROUTES.costAndUsage.llmPrices,
        icon: <IconLlmPrices />,
      },
      {
        label: 'Token Budgets',
        href: CONTROL_ROUTES.costAndUsage.tokenBudgets,
        icon: <IconTokenBudgets />,
      },
      {
        label: 'Usage',
        href: CONTROL_ROUTES.costAndUsage.usage,
        icon: <IconUsageHistory />,
      },
    ],
  },
  'communication-channels': {
    label: 'External Channels',
    href: CONTROL_ROUTES.externalChannels.root,
    icon: <IconBroadcast />,
  },
  files: {
    label: 'Files',
    href: CONTROL_ROUTES.globalFiles,
    icon: <IconFolder />,
    children: [
      { label: 'Global Files', href: CONTROL_ROUTES.globalFiles, icon: <IconFolder /> },
      {
        label: 'Outputs',
        href: CONTROL_ROUTES.outputs.root,
        icon: <IconOutputs />,
        matchPath: CONTROL_ROUTES.outputs.base,
      },
      {
        label: 'Shared Files',
        href: CONTROL_ROUTES.sharedFiles.root,
        icon: <IconSharedFiles />,
      },
    ],
  },
  'llm-models': {
    label: 'LLM Models',
    href: CONTROL_ROUTES.llmModels.root,
    icon: <IconModels />,
    children: [
      {
        label: 'Catalog',
        href: CONTROL_ROUTES.llmModels.root,
        icon: <IconModelCatalog />,
      },
      {
        label: 'Discovery',
        href: CONTROL_ROUTES.llmModels.discovery,
        icon: <IconModelDiscovery />,
      },
    ],
  },
  'registry-catalog': {
    label: 'Marketplace',
    href: CONTROL_ROUTES.marketplace.connectors,
    icon: <IconStore />,
  },
  'workflow-recipes': {
    label: 'Plugins',
    href: CONTROL_ROUTES.plugins.root,
    icon: <IconWorkflow />,
  },
  publisher: { label: 'Publisher', href: CONTROL_ROUTES.publisher.root, icon: <IconPublish /> },
  'llm-secrets': { label: 'Secrets', href: CONTROL_ROUTES.secrets.llm, icon: <IconKey /> },
  traces: {
    label: 'Traces',
    href: CONTROL_ROUTES.traces.root,
    icon: <IconWorkflow />,
    hidden: true,
    children: [
      {
        label: 'Dashboard',
        href: CONTROL_ROUTES.traces.operations,
        icon: <IconTraceDashboard />,
      },
      {
        label: 'Run replay',
        href: CONTROL_ROUTES.traces.root,
        icon: <IconRunReplay />,
      },
      {
        label: 'Administrative',
        href: CONTROL_ROUTES.traces.administrative,
        icon: <IconAdministrativeTrace />,
      },
      {
        label: 'Infrastructure',
        href: CONTROL_ROUTES.traces.infrastructure,
        icon: <IconInfrastructureTrace />,
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
