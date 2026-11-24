export const CHANNEL_STEP_LABELS = ['Channel', 'Provider', 'Access'] as const

export const CHANNEL_STEP_DETAILS = [
  {
    description: 'Name and assign the channel',
    title: 'Channel identity',
    subtitle: 'Choose the Kubernetes identity and agent that owns this channel.',
  },
  {
    description: 'Connection and credentials',
    title: 'Provider setup',
    subtitle: 'Select a provider and add its write-only credentials.',
  },
  {
    description: 'Members and teams',
    title: 'Communication access',
    subtitle:
      'Choose which members and teams with existing access to this agent can chat through this channel.',
  },
] as const
