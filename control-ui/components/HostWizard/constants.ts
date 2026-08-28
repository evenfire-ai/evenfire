export const HOST_SECRET_LABEL_KEY = 'clerum.io/host-secret'
export const HOST_SECRET_LABEL_VALUE = 'true'
export const HOST_NAMESPACE = 'mcp-host'

export const STEPS = ['Agent', 'Model & Credentials', 'Access', 'Add Connectors'] as const

export const STEP_DETAILS = [
  {
    description: 'Define identity & namespace',
    title: 'Agent identity',
    subtitle: 'Give your agent a unique name within the selected namespace.',
  },
  {
    description: 'Choose model and credentials',
    title: 'Model & credentials',
    subtitle: 'Select the model provider and connect the LLM API keys it will use.',
  },
  {
    description: 'Set permissions and sharing',
    title: 'Access',
    subtitle: 'Grant members or teams permission to use this agent.',
  },
  {
    description: 'Choose available connectors',
    title: 'Add connectors',
    subtitle: 'Choose the connectors this agent can use. You can leave this empty.',
  },
] as const
