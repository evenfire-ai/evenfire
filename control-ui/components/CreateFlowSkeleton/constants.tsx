import type { ReactNode } from 'react'
import {
  IconBroadcast,
  IconCable,
  IconGroupWork,
  IconKey,
  IconRobot,
  IconSettings,
  IconSharedFiles,
  IconStore,
  IconUsers,
  IconWorkflow,
} from '@components/Sidebar/icons'
import type { CreateFlowIconKey } from './types'

export const CREATE_FLOW_SKELETON_ICONS: Record<CreateFlowIconKey, ReactNode> = {
  broadcast: <IconBroadcast />,
  cable: <IconCable />,
  'group-work': <IconGroupWork />,
  key: <IconKey />,
  robot: <IconRobot />,
  settings: <IconSettings />,
  'shared-files': <IconSharedFiles />,
  store: <IconStore />,
  users: <IconUsers />,
  workflow: <IconWorkflow />,
}
