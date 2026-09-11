export type IdentityFieldKey = 'identity' | 'soul' | 'agents' | 'user'

export type IdentityFields = Record<IdentityFieldKey, string>

export type IdentityFieldConfig = {
  fileName: string
  help: string
  key: IdentityFieldKey
  label: string
  placeholder: string
  promptHeader: string
}

export type HostIdentityTabState = {
  activeField: IdentityFieldKey
  error: string
  fields: IdentityFields
  initial: IdentityFields
  loading: boolean
  reloadHint: boolean
  resourceVersion: string
  saving: boolean
}
