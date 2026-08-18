type QueryValue = boolean | number | string | null | undefined

export type ControlRouteQuery = Record<string, QueryValue>

function segment(value: string): string {
  return encodeURIComponent(value)
}

function withQuery(path: string, query?: ControlRouteQuery): string {
  if (!query) return path

  const params = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      params.set(key, String(value))
    }
  })
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

export function isControlRouteSection(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}

export const CONTROL_ROUTES = {
  login: '/',
  loginWith: (query?: ControlRouteQuery) => withQuery('/', query),
  agents: {
    root: '/agents',
    new: '/agents/new',
    detail: (name: string) => `/agents/${segment(name)}`,
    tab: (name: string, tab: string) => `/agents/${segment(name)}/${segment(tab)}`,
  },
  connectors: {
    root: '/connectors',
    new: '/connectors/new',
    edit: (name: string) => `/connectors/${segment(name)}/edit`,
    editTab: (name: string, tab: string) => `/connectors/${segment(name)}/edit/${segment(tab)}`,
  },
  contexts: {
    root: '/contexts',
    new: '/contexts/new',
    detail: (name: string) => `/contexts/${segment(name)}`,
    tab: (name: string, tab: string) => `/contexts/${segment(name)}/${segment(tab)}`,
    connectors: (name: string) => `/contexts/${segment(name)}/connectors`,
  },
  costAndUsage: {
    base: '/cost-and-usage',
    root: '/cost-and-usage/usage',
    usage: '/cost-and-usage/usage',
    llmPrices: '/cost-and-usage/llm-prices',
    newLlmPrice: (query?: ControlRouteQuery) => withQuery('/cost-and-usage/llm-prices/new', query),
    editLlmPrice: (id: string) => `/cost-and-usage/llm-prices/${segment(id)}/edit`,
    tokenBudgets: '/cost-and-usage/token-budgets',
    newTokenBudget: '/cost-and-usage/token-budgets/new',
    editTokenBudget: (id: string) => `/cost-and-usage/token-budgets/${segment(id)}/edit`,
  },
  externalChannels: {
    root: '/external-channels',
    new: (query?: ControlRouteQuery) => withQuery('/external-channels/new', query),
    edit: (name: string) => `/external-channels/${segment(name)}/edit`,
  },
  globalFileSystem: '/global-file-system',
  llmModels: {
    root: '/llm-models',
    discovery: '/llm-models/discovery',
    new: '/llm-models/new',
    edit: (id: string) => `/llm-models/${segment(id)}/edit`,
  },
  marketplace: {
    root: '/marketplace',
    connectors: '/marketplace/connectors',
    plugins: '/marketplace/plugins',
    // The org-named tab (design spec §4): everything this deployment owns.
    org: '/marketplace/org',
    orgEntries: '/marketplace/org/entries',
    orgImages: '/marketplace/org/images',
    orgCredentials: '/marketplace/org/credentials',
    orgConnection: '/marketplace/org/connection',
    install: (query?: ControlRouteQuery) => withQuery('/marketplace/install', query),
    publish: (query?: ControlRouteQuery) => withQuery('/marketplace/publish', query),
    keys: '/marketplace/keys',
    connect: '/marketplace/connect',
    entry: (name: string, version: string) =>
      `/marketplace/entries/${segment(name)}/${segment(version)}`,
    editEntry: (name: string, version: string) =>
      `/marketplace/entries/${segment(name)}/${segment(version)}/edit`,
  },
  agentOutputs: {
    base: '/agent-outputs',
    root: '/agent-outputs/recipe-artifacts',
    recipeArtifacts: '/agent-outputs/recipe-artifacts',
    desktopAppArtifacts: '/agent-outputs/desktop-app-artifacts',
  },
  plugins: {
    root: '/plugins',
    sdk: '/plugins/sdk',
    detail: (namespace: string, name: string) => `/plugins/${segment(namespace)}/${segment(name)}`,
    edit: (namespace: string, name: string) =>
      withQuery(`/plugins/${segment(namespace)}/${segment(name)}`, { edit: 1 }),
    tab: (namespace: string, name: string, tab: string) =>
      `/plugins/${segment(namespace)}/${segment(name)}/${segment(tab)}`,
    run: (namespace: string, name: string, runId: string) =>
      `/plugins/${segment(namespace)}/${segment(name)}/runs/${segment(runId)}`,
  },
  publisher: {
    root: '/publisher',
    entries: '/publisher/entries',
    sharedWithMe: '/publisher/shared-with-me',
    credentials: '/publisher/credentials',
  },
  secrets: {
    root: '/secrets',
    llm: '/secrets/llm',
    connector: '/secrets/connector',
    recipe: '/secrets/recipe',
    new: (query?: ControlRouteQuery) => withQuery('/secrets/new', query),
    editRecipe: (name: string, query?: ControlRouteQuery) =>
      withQuery(`/secrets/recipe/${segment(name)}/edit`, query),
  },
  settings: {
    root: '/settings',
    ui: '/settings/ui',
    withFocus: (focus: string) => withQuery('/settings', { focus }),
  },
  agentFiles: {
    root: '/agent-files',
    new: '/agent-files/new',
    detail: (name: string) => `/agent-files/${segment(name)}`,
  },
  traces: {
    root: '/traces',
    operations: '/traces/operations',
    administrative: '/traces/administrative',
    administrativeEvent: (eventId: string) => `/traces/administrative/${segment(eventId)}`,
    hosts: '/traces/hosts',
    hostRun: (hostRef: string, runId: string) =>
      `/traces/hosts/${segment(hostRef)}/runs/${segment(runId)}`,
    infrastructure: '/traces/infrastructure',
    infrastructureEvent: (eventId: string) => `/traces/infrastructure/${segment(eventId)}`,
    sessions: '/traces/sessions',
    session: (hostRef: string, sessionId: string) =>
      `/traces/sessions/${segment(hostRef)}/${segment(sessionId)}`,
    workflows: '/traces/workflows',
    workflowRun: (namespace: string, name: string, runId: string) =>
      `/traces/workflows/${segment(namespace)}/${segment(name)}/runs/${segment(runId)}`,
  },
  usersAndTeams: {
    base: '/users-and-teams',
    root: '/users-and-teams/users',
    users: '/users-and-teams/users',
    newUser: (query?: ControlRouteQuery) => withQuery('/users-and-teams/users/new', query),
    user: (userId: string) => `/users-and-teams/users/${segment(userId)}`,
    userTab: (userId: string, tab: string) =>
      `/users-and-teams/users/${segment(userId)}/${segment(tab)}`,
    teams: '/users-and-teams/teams',
    newTeam: '/users-and-teams/teams/new',
    team: (teamId: string) => `/users-and-teams/teams/${segment(teamId)}`,
    teamTab: (teamId: string, tab: string) =>
      `/users-and-teams/teams/${segment(teamId)}/${segment(tab)}`,
    admins: (query?: ControlRouteQuery) => withQuery('/users-and-teams/admins', query),
    newAdmin: (query?: ControlRouteQuery) => withQuery('/users-and-teams/admins/new', query),
  },
  adminInvitations: {
    detail: (token: string, query?: ControlRouteQuery) =>
      withQuery(`/admin-invitations/${segment(token)}`, query),
    complete: (token: string) => `/admin-invitations/${segment(token)}/complete`,
    setupComplete: (query?: ControlRouteQuery) =>
      withQuery('/admin-invitations/setup-complete', query),
  },
  adminPasswordResets: {
    detail: (token: string, query?: ControlRouteQuery) =>
      withQuery(`/admin-password-resets/${segment(token)}`, query),
    formAction: (token: string) => `/admin-password-resets/${segment(token)}/complete`,
    complete: (query?: ControlRouteQuery) => withQuery('/admin-password-resets/complete', query),
  },
} as const
