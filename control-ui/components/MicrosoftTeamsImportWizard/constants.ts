export const MICROSOFT_GUIDE_ROOT = '/guides/integrations/microsoft-teams'

export const MICROSOFT_IMPORT_STEP_LABELS = [
  'Get started',
  'App registration',
  'Client secret',
  'Permissions',
  'Values',
  'Authorize',
  'Teams',
  'Members',
  'Review',
] as const

export const MICROSOFT_IMPORT_STEP_DETAILS = [
  {
    description: 'Prepare the integration',
    title: 'Get started',
    subtitle: 'Create a customer-owned Microsoft app registration for this organization.',
  },
  {
    description: 'Register the application',
    title: 'Create an app registration',
    subtitle: 'Configure the application and its Evenfire OAuth callback.',
  },
  {
    description: 'Create a credential',
    title: 'Create a client secret',
    subtitle: 'Give Evenfire an encrypted credential for Microsoft authorization.',
  },
  {
    description: 'Grant Graph access',
    title: 'Add delegated permissions',
    subtitle: 'Allow Evenfire to read the organization directory and Microsoft Teams.',
  },
  {
    description: 'Copy application IDs',
    title: 'Complete the application values',
    subtitle: 'Copy the tenant and application identifiers from Microsoft Entra.',
  },
  {
    description: 'Consent for the organization',
    title: 'Authorize with Microsoft',
    subtitle: 'Sign in to grant consent and connect the Microsoft organization.',
  },
  {
    description: 'Map team structure',
    title: 'Teams',
    subtitle: 'Choose Microsoft Teams to import and configure their Evenfire destinations.',
  },
  {
    description: 'Choose organization members',
    title: 'Evenfire Members',
    subtitle: 'Select members, confirm names, and assign their Evenfire teams.',
  },
  {
    description: 'Confirm the import',
    title: 'Review and send',
    subtitle: 'Review the changes before creating teams, members, and invitations.',
  },
] as const

export const MICROSOFT_GRAPH_PERMISSIONS = [
  'User.Read',
  'User.Read.All',
  'GroupMember.Read.All',
] as const

export const MICROSOFT_IMPORT_DEBOUNCE_MS = 600
export const MICROSOFT_INVITATION_CHUNK_WAIT_MS = 15_000
