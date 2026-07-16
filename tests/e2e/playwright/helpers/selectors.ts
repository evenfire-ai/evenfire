/**
 * Centralized selectors for Playwright tests.
 *
 * No data-testid attributes exist in the codebase yet, so we use:
 *   - Explicit IDs where available (#dev-email-input)
 *   - ARIA roles + text (button, heading, etc.)
 *   - Placeholder text for inputs
 *   - CSS classes for nav (.nav-link)
 *
 * When data-testid attributes are added to components, update this file
 * rather than editing each spec — that's the point of centralizing here.
 */

// ── Control UI — Auth screen ──────────────────────────────────────────────────
export const CUI_AUTH = {
  USERNAME_INPUT: '#cu-login-user',
  PASSWORD_INPUT: '#cu-login-pass',
  SIGN_IN_BUTTON: 'button[type="submit"]:has-text("Sign in")',
  // Login page auth modes are 'login' | 'forgot-password' (control-ui/app/page.tsx).
  // The old first-run "Account creation" tab no longer exists on this page.
  FORGOT_PASSWORD_LINK: 'button.cu-auth-secondary-link:has-text("Forgot my password")',
  RESET_USERNAME_INPUT: '#cu-reset-user',
  SEND_RESET_BUTTON: 'button[type="submit"]:has-text("Send reset link")',
  BACK_TO_SIGN_IN_LINK: 'button.cu-auth-secondary-link:has-text("Back to sign in")',
  ERROR_MESSAGE: '.cu-banner--error',
  // The auth screen has no <h1>; the hint paragraph is its stable anchor.
  PAGE_HEADING: '.cu-card--auth .cu-code-hint',
} as const

// ── Control UI — Dashboard ────────────────────────────────────────────────────
export const CUI_DASHBOARD = {
  // The dashboard has no h1.cu-sidebar__title anymore; the sidebar <aside>
  // (control-ui/components/Sidebar/index.tsx) is the authenticated anchor.
  HEADING: 'aside.cu-sidebar[aria-label="Main navigation"]',
  LOGOUT_BUTTON: '.cu-sidebar__item--utility:has-text("Log out")',
  REFRESH_BUTTON: 'button[aria-label="Reload agents"]',

  TAB_AGENTS: '.cu-sidebar__item:has-text("Agents")',
  TAB_HOSTS: '.cu-sidebar__item:has-text("Agents")',
  TAB_CONTEXTS: '.cu-sidebar__item:has-text("Contexts")',
  TAB_MCP_SERVERS: '.cu-sidebar__item:has-text("Connectors")',
  TAB_CHANNELS: '.cu-sidebar__item:has-text("External Channels")',
  TAB_MEMBERS_TEAMS: '.cu-sidebar__item:has-text("Users & Teams")',
  TAB_USERS_TEAMS: '.cu-sidebar__item:has-text("Users & Teams")',
  TAB_WORKFLOW_RECIPES: '.cu-sidebar__item:has-text("Plugins")',

  CREATE_HOST_BUTTON: 'button:has-text("Create agent")',
  CREATE_CONTEXT_BUTTON: 'button:has-text("Create context")',
  LOADING_INDICATOR: 'div:has-text("Loading...")',
} as const

// ── Control UI — Hosts table ──────────────────────────────────────────────────
export const CUI_HOSTS = {
  TABLE: 'table',
  // :text-is() = exact text match (avoids "Namespace" matching "Name" substring)
  TABLE_HEADER_NAME: 'th:text-is("Name")',
  TABLE_HEADER_NAMESPACE: 'th:text-is("Namespace")',
  // Host Wizard — no semantic h2, detect wizard by presence of Close button
  WIZARD_CLOSE_BUTTON: 'button[aria-label="Close"]',
} as const

// ── Control UI — Contexts table ───────────────────────────────────────────────
export const CUI_CONTEXTS = {
  TABLE: 'table',
  TABLE_HEADER_NAME: 'th:has-text("Context Name")',
  TABLE_HEADER_MCP_SERVERS: 'th:has-text("MCP servers")',
} as const

// ── Control UI — Users & Teams ────────────────────────────────────────────────
// IMPORTANT: scope sub-tab selectors to <section> — the main nav has a
// "Members & Teams" tab that would match 'button:has-text("Members|Teams")' globally.
export const CUI_USERS_TEAMS = {
  SECTION_HEADING: '.cu-panel-title:has-text("Members and Teams")',
  TEAMS_TAB: '.cu-tab:has-text("Teams")',
  USERS_TAB: '.cu-tab:has-text("Members")',
  CREATE_TEAM_BUTTON: 'button:has-text("Create team")',
  TEAMS_COUNT: (count: number) => `strong:has-text("Teams (${count})")`,
  USERS_COUNT_LABEL: 'strong', // "Users (N)"
  SEARCH_INPUT: 'input[placeholder="Search members"]',
  USER_TABLE: 'table',
  TEAM_TABLE: 'table',
} as const

// ── Control UI — Workflow Recipes ─────────────────────────────────────────────
export const CUI_RECIPES = {
  INSTALL_BUTTON: 'button:has-text("Install Recipe")',
  REFRESH_BUTTON: 'button[aria-label="Reload workflow recipes"]',
  EMPTY_STATE: 'p:has-text("No WorkflowRecipes installed")',
  TABLE: 'table',
  TABLE_HEADER_NAME: 'th:text-is("Name")',
  TABLE_HEADER_PHASE: 'th:text-is("Phase")',

  // Editor
  EDITOR_TITLE_CREATE: 'h3:has-text("Install WorkflowRecipe")',
  EDITOR_TITLE_EDIT: (name: string) => `h3:has-text("Edit Recipe: ${name}")`,
  EDITOR_TEXTAREA: 'textarea',
  EDITOR_CANCEL_BUTTON: "button:has-text('✕')",
  VALIDATE_BUTTON: 'button:has-text("Validate")',
  VALIDATION_PASSED: ':text("Validation passed")',
  VALIDATION_FAILED: ':text-matches("Validation failed")',
  APPLY_DEFAULTS_BUTTON: 'button:has-text("Apply Operator Defaults")',
  DEPLOY_BUTTON: 'button:has-text("Deploy Recipe")',
  UPDATE_BUTTON: 'button:has-text("Update Recipe")',

  // Per-row actions
  STATUS_BUTTON: (name: string) => `tr:has-text("${name}") button:has-text("Status")`,
  EDIT_BUTTON: (name: string) => `tr:has-text("${name}") button:has-text("Edit")`,
  UNINSTALL_BUTTON: (name: string) => `tr:has-text("${name}") button:has-text("Uninstall")`,

  // Status modal
  STATUS_MODAL_HEADING: 'h3:has-text("Recipe Status")',
  STATUS_MODAL_CLOSE: 'button:has-text("Close")',
  STATUS_MODAL_LIVE_BADGE: ':text("● Live")',
  STATUS_MODAL_WF_EXECUTION: ':text("Workflow Execution")',
  STATUS_MODAL_STEPS_HEADING: (n: number) => `:text("Steps (${n})")`,
  STATUS_MODAL_WORKLOAD_PHASE: ':text("Workload Phase:")',
  STATUS_MODAL_RAW_JSON: 'summary:has-text("Raw JSON")',
  STATUS_MODAL_COPY_JSON: 'button:has-text("Copy JSON")',
  STATUS_MODAL_FAILURE_TITLE: ':text("Workflow Execution Failed")',
  STATUS_MODAL_DEBUG_COMMANDS: ':text("Debug commands:")',
} as const

// ── Desktop App — Auth page ───────────────────────────────────────────────────
export const DESKTOP_AUTH = {
  HEADING: 'h1:has-text("Evenfire Desktop")',
  EMAIL_INPUT: '#dev-email-input',
  SIGN_IN_BUTTON: 'button:has-text("Sign in")',
  STATUS_BANNER: '.status-banner',
  AUTH_CARD: '.auth-card',
} as const

// ── Desktop App — Sidebar navigation ─────────────────────────────────────────
export const DESKTOP_NAV = {
  AGENTS: 'button.nav-link:has-text("Agents")',
  CONTEXTS: 'button.nav-link:has-text("Contexts")',
  TEAMS: 'button.nav-link:has-text("Teams")',
  MCP_SERVERS: 'button.nav-link:has-text("MCP Servers")',
  RECIPES: 'button.nav-link:has-text("Recipes")',
  ACTIVE: 'button.nav-link.active',
} as const

// ── Desktop App — Agents page ─────────────────────────────────────────────────
export const DESKTOP_AGENTS = {
  PAGE_HEADING: 'h2:has-text("Agents")',
  AGENT_LIST: '.agent-list, table, ul',
  NO_AGENTS_TEXT: 'p:has-text("No agents")',
} as const

// ── Desktop App — Contexts page ───────────────────────────────────────────────
export const DESKTOP_CONTEXTS = {
  PAGE_HEADING: 'h2:has-text("Contexts")',
} as const

// ── Desktop App — Recipes page ────────────────────────────────────────────────
export const DESKTOP_RECIPES = {
  PAGE_HEADING: 'h2:has-text("Recipes")',
  LOAD_FILE_BUTTON: 'button:has-text("Load from File")',
} as const
