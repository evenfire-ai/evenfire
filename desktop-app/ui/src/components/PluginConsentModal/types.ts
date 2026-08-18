export type PluginConsentTier = 'personal' | 'workspace' | 'ambient'

export type PluginConsentRow = {
  capability: string
  title: string
  dataDescription: string
  tier: PluginConsentTier
}

export type PluginConsentRequest = {
  promptId: string
  pluginId: string
  pluginTitle: string
  rows: PluginConsentRow[]
  priorPromptCount: number
}

export type PluginConsentModalProps = {
  request: PluginConsentRequest
  /** Resolve with the capabilities the user left checked. */
  onResolve: (promptId: string, allowed: string[]) => void
}
