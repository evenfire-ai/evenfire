const statusEl = document.getElementById('status')
const tabButtons = Array.from(document.querySelectorAll('.tab-btn'))
const tabPanels = Array.from(document.querySelectorAll('.tab-panel'))
const leftNavButtons = Array.from(document.querySelectorAll('.left-nav-btn'))
const loginBtn = document.getElementById('login-btn')
const leftViewTitleEl = document.getElementById('left-view-title')
const leftViewContentEl = document.getElementById('left-view-content')

const passwordEmailInput = document.getElementById('password-email')
const passwordInput = document.getElementById('password-password')
const passwordLoginBtn = document.getElementById('password-login-btn')
const passwordLoginSection = document.getElementById('password-login-section')
const googleTokenInput = document.getElementById('google-id-token')
const googleLoginBtn = document.getElementById('google-login-btn')
const googleLoginSection = document.getElementById('google-login-section')

const userLabel = document.getElementById('user-label')
const teamLabel = document.getElementById('team-label')
const logoutBtn = document.getElementById('logout-btn')
const teamSelect = document.getElementById('team-select')
const switchTeamBtn = document.getElementById('switch-team-btn')
const refreshAccessBtn = document.getElementById('refresh-access-btn')
const contextsListEl = document.getElementById('contexts-list')
const agentsListEl = document.getElementById('agents-list')
const hostRefsInput = document.getElementById('host-refs-input')
const refreshServersBtn = document.getElementById('refresh-servers-btn')
const serverSelect = document.getElementById('server-select')
const rpcRequestEl = document.getElementById('rpc-request')
const invokeBtn = document.getElementById('invoke-btn')
const rpcResponseEl = document.getElementById('rpc-response')
const refreshTokenMetaBtn = document.getElementById('refresh-token-meta-btn')
const tokenMetaEl = document.getElementById('token-meta')

let teams = []
let accessCatalog = null
let isAuthenticated = false
let leftNavTab = 'agents'
let availableConnectors = []

function updateAuthMode() {
  const hasGoogleToken = String(googleTokenInput.value || '').trim().length > 0
  if (hasGoogleToken) {
    passwordLoginSection.classList.add('hidden')
    googleLoginSection.classList.remove('hidden')
  } else {
    passwordLoginSection.classList.remove('hidden')
    googleLoginSection.classList.add('hidden')
  }
}

function setStatus(message, payload) {
  statusEl.textContent = payload ? `${message}\n${JSON.stringify(payload, null, 2)}` : message
}

function setActiveTab(tabName) {
  for (const button of tabButtons) {
    const isActive = button.dataset.tab === tabName
    button.classList.toggle('active', isActive)
  }
  for (const panel of tabPanels) {
    const isActive = panel.dataset.tabPanel === tabName
    panel.classList.toggle('hidden', !isActive)
  }
}

function updateAuthButtons() {
  loginBtn.classList.toggle('hidden', isAuthenticated)
  logoutBtn.classList.toggle('hidden', !isAuthenticated)
}

function setLeftNavTab(tabName) {
  leftNavTab = tabName
  for (const button of leftNavButtons) {
    button.classList.toggle('active', button.dataset.leftTab === tabName)
  }
  renderLeftPane()
}

function hostRefsFromInput() {
  const raw = String(hostRefsInput.value || '').trim()
  if (!raw) return undefined
  return raw
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
}

function normalizeServerEntry(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim()
    return name ? { name, label: name } : null
  }
  if (!entry || typeof entry !== 'object') return null
  const name = String(entry.name || '').trim()
  if (!name) return null
  const url = String(entry.url || '').trim()
  return {
    name,
    label: url ? `${name} -> ${url}` : name,
  }
}

function renderAccessList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return '[]'
  }
  return values.join('\n')
}

function renderLeftPane() {
  if (!leftViewTitleEl || !leftViewContentEl) return

  if (!isAuthenticated) {
    leftViewTitleEl.textContent = 'Sign in required'
    leftViewContentEl.textContent = 'Sign in to explore agents, connectors, contexts, and teams.'
    return
  }

  if (leftNavTab === 'agents') {
    leftViewTitleEl.textContent = 'Agents (MCP-hosts)'
    leftViewContentEl.textContent = renderAccessList(accessCatalog?.agentNames || [])
    return
  }
  if (leftNavTab === 'connectors') {
    leftViewTitleEl.textContent = 'Connectors (MCP-servers)'
    leftViewContentEl.textContent = renderAccessList(availableConnectors)
    return
  }
  if (leftNavTab === 'contexts') {
    leftViewTitleEl.textContent = 'Contexts'
    leftViewContentEl.textContent = renderAccessList(accessCatalog?.contextIds || [])
    return
  }
  if (leftNavTab === 'teams') {
    leftViewTitleEl.textContent = 'Teams'
    leftViewContentEl.textContent = renderAccessList(
      (teams || []).map(team => `${team.name} (${team.role}) [${team.id}]`)
    )
  }
}

function updateAccessUi(catalog) {
  accessCatalog = catalog
  contextsListEl.textContent = renderAccessList(catalog?.contextIds || [])
  agentsListEl.textContent = renderAccessList(catalog?.agentNames || [])
  const currentHostRefs = String(hostRefsInput.value || '').trim()
  if (!currentHostRefs && Array.isArray(catalog?.agentNames) && catalog.agentNames.length > 0) {
    hostRefsInput.value = catalog.agentNames.join(', ')
  }
  renderLeftPane()
}

function defaultRpcRequest() {
  return JSON.stringify(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    },
    null,
    2
  )
}

async function refreshSessionUi() {
  const state = await window.clerum.auth.getSessionState()
  isAuthenticated = Boolean(state.authenticated && state.me)
  updateAuthButtons()

  if (!state.authenticated || !state.me) {
    userLabel.textContent = 'Not logged in'
    teamLabel.textContent = 'No active team'
    teamSelect.innerHTML = ''
    teamSelect.disabled = true
    switchTeamBtn.disabled = true
    serverSelect.innerHTML = ''
    contextsListEl.textContent = '[]'
    agentsListEl.textContent = '[]'
    tokenMetaEl.textContent = ''
    accessCatalog = null
    availableConnectors = []
    renderLeftPane()
    setActiveTab('auth')
    return
  }

  userLabel.textContent = `${state.me.email} (${state.me.role || 'unknown'})`
  teamLabel.textContent = `Current team: ${state.me.teamName || 'none'} (${state.me.teamId || '-'})`
  teamSelect.disabled = false
  switchTeamBtn.disabled = false

  const teamList = await window.clerum.team.list()
  teams = Array.isArray(teamList.items) ? teamList.items : []
  teamSelect.innerHTML = ''
  for (const team of teams) {
    const option = document.createElement('option')
    option.value = team.id
    option.textContent = `${team.name} (${team.role})`
    if (team.id === teamList.currentTeamId) option.selected = true
    teamSelect.appendChild(option)
  }
  renderLeftPane()

  try {
    const catalog = await window.clerum.access.refreshCatalog()
    updateAccessUi(catalog)
  } catch (error) {
    updateAccessUi({
      userId: state.me.id,
      teamId: state.me.teamId || null,
      userContextIds: [],
      userAgentNames: [],
      teamContextIds: [],
      teamAgentNames: [],
      contextIds: [],
      agentNames: [],
    })
    setStatus(
      `Access catalog load failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!rpcRequestEl.value) {
    rpcRequestEl.value = defaultRpcRequest()
  }

  setActiveTab('main')
}

async function refreshServers() {
  setStatus('Loading authorized servers...')
  const refs = hostRefsFromInput() || accessCatalog?.agentNames
  if (!refs || refs.length === 0) {
    throw new Error(
      'No authorized host refs available. Refresh access or provide host refs manually.'
    )
  }
  const result = await window.clerum.rpc.listServers(refs)
  serverSelect.innerHTML = ''
  const connectors = []
  for (const rawServer of result.servers || []) {
    const server = normalizeServerEntry(rawServer)
    if (!server) continue
    const option = document.createElement('option')
    option.value = server.name
    option.textContent = server.label
    serverSelect.appendChild(option)
    connectors.push(server.name)
  }
  availableConnectors = connectors
  renderLeftPane()
  setStatus(`Loaded ${result.servers?.length || 0} server(s).`, result)
}

async function refreshTokenMeta() {
  const meta = await window.clerum.rpc.getTokenMetadata()
  tokenMetaEl.textContent = JSON.stringify(meta, null, 2)
}

passwordLoginBtn.addEventListener('click', async () => {
  try {
    const email = String(passwordEmailInput.value || '')
      .trim()
      .toLowerCase()
    const password = String(passwordInput.value || '')
    if (!email) throw new Error('email is required')
    if (!password) throw new Error('password is required')
    await window.clerum.auth.passwordLogin(email, password)
    setStatus('Signed in via password login.')
    await refreshSessionUi()
  } catch (error) {
    setStatus(`Login failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})

googleLoginBtn.addEventListener('click', async () => {
  try {
    const idToken = String(googleTokenInput.value || '').trim()
    if (!idToken) throw new Error('Google ID token is required')
    await window.clerum.auth.googleLogin(idToken)
    setStatus('Signed in via Google token.')
    await refreshSessionUi()
  } catch (error) {
    setStatus(`Google login failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})

googleTokenInput.addEventListener('input', updateAuthMode)

logoutBtn.addEventListener('click', async () => {
  try {
    await window.clerum.auth.logout()
    rpcResponseEl.textContent = ''
    tokenMetaEl.textContent = ''
    serverSelect.innerHTML = ''
    setStatus('Logged out.')
    await refreshSessionUi()
  } catch (error) {
    setStatus(`Logout failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})

switchTeamBtn.addEventListener('click', async () => {
  try {
    const teamId = String(teamSelect.value || '').trim()
    if (!teamId) throw new Error('Select a team')
    await window.clerum.team.switch(teamId)
    setStatus(`Switched team to ${teamId}.`)
    await refreshSessionUi()
    await refreshTokenMeta()
  } catch (error) {
    setStatus(`Switch team failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})

refreshServersBtn.addEventListener('click', async () => {
  try {
    await refreshServers()
    await refreshTokenMeta()
  } catch (error) {
    setStatus(`Load servers failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})

refreshAccessBtn.addEventListener('click', async () => {
  try {
    const catalog = await window.clerum.access.refreshCatalog()
    updateAccessUi(catalog)
    setStatus('Access catalog refreshed from external-rest-api.', catalog)
  } catch (error) {
    setStatus(`Refresh access failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})

invokeBtn.addEventListener('click', async () => {
  try {
    const selected = serverSelect.options[serverSelect.selectedIndex]
    if (!selected) throw new Error('Select a server first')
    const response = await window.clerum.rpc.invoke(
      selected.value,
      String(rpcRequestEl.value || '').trim(),
      hostRefsFromInput() || [selected.value]
    )
    rpcResponseEl.textContent = JSON.stringify(response, null, 2)
    setStatus(`Invocation complete for ${selected.value}.`, response)
    await refreshTokenMeta()
  } catch (error) {
    setStatus(`Invoke failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})

refreshTokenMetaBtn.addEventListener('click', async () => {
  try {
    await refreshTokenMeta()
    setStatus('Token metadata refreshed.')
  } catch (error) {
    setStatus(`Token metadata failed: ${error instanceof Error ? error.message : String(error)}`)
  }
})

loginBtn.addEventListener('click', () => {
  setActiveTab('auth')
})

for (const button of tabButtons) {
  button.addEventListener('click', () => {
    const tab = String(button.dataset.tab || 'main')
    setActiveTab(tab)
  })
}

for (const button of leftNavButtons) {
  button.addEventListener('click', () => {
    setLeftNavTab(String(button.dataset.leftTab || 'agents'))
  })
}

refreshSessionUi().catch(error => {
  setStatus(`Startup failed: ${error instanceof Error ? error.message : String(error)}`)
})

updateAuthMode()
setLeftNavTab('agents')
