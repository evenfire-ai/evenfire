/**
 * Contract: prepared isolated user/agent/subscription and unapproved fixture
 * connector -> visible Control UI login/configuration/approval -> isolated
 * Desktop login/chat -> persisted MCP receipt -> visible revocation -> denial.
 * Every transition checks UI/state and the saved binding or actual MCP result.
 * Entry contract: Control UI starts at its application root.
 * E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process login and chat IPC.
 * Completed messages and MCP evidence replace renderer response waits. Tests
 * never inject IPC calls or authentication. Only the external OAuth and model
 * providers are simulated in deterministic mode.
 *
 * #1048 MS-NW: this journey left the base approved-tools group. It is the only
 * case that needs the custom coordinator image, so it is its own suite run
 * (`APPROVED_TOOLS_SUITE=native-workflow`) and its own prepared fixture set; the
 * base suite keeps the seven journeys that need none of that. The case itself is
 * unchanged.
 */
import { test } from '@playwright/test'
import { localUrl, required } from '../helpers/approved-tools-scenarios'
import { workflowJourney } from '../helpers/approved-tools-workflow'

const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
if (!['deterministic', 'real'].includes(mode))
  throw new Error('APPROVED_TOOLS_UPSTREAM_MODE must be deterministic or real')
if (mode === 'real' && process.env.CODEX_REAL_UPSTREAM_CONFIRM !== '1')
  throw new Error('Real subscription requires explicit CODEX_REAL_UPSTREAM_CONFIRM=1')
for (const key of [
  'TEST_ADMIN_USERNAME',
  'TEST_ADMIN_PASSWORD',
  'TEST_USER_EMAIL',
  'TEST_USER_PASSWORD',
])
  required(key)
for (const key of ['EXTERNAL_REST_API_BASE_URL', 'RPC_PROXY_BASE_URL']) localUrl(required(key))
if (process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true')
  throw new Error('Verified Desktop build is required; this lane never skips')

test('native workflow: visible approval, trigger, status and result artifact', async ({
  page,
}, testInfo) => {
  await workflowJourney(page, testInfo)
})
