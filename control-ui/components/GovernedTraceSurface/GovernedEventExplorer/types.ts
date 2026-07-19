import type { GovernedEventFamily } from '@lib/governedTrace'

export type GovernedEventExplorerProps = {
  family: Extract<GovernedEventFamily, 'administrative' | 'infrastructure_telemetry'>
  subtitle: string
  title: string
}
