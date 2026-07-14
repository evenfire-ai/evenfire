import type { ReactNode } from 'react'
import type { EnvSecretKeyMapping, EnvVar } from '@/lib/api'

export type CreateMcpServerFormProps = {
  mode?: 'inline' | 'page'
  onCancel: () => void
  onCreated: () => void
  pageHeader?: ReactNode
}

export type TransportType = 'streamableHttp' | 'sse' | 'stdio'

export type TransportOption = {
  label: string
  value: TransportType
}

export type SecretMappingRow = EnvSecretKeyMapping
export type EnvironmentRow = EnvVar
