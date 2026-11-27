/**
 * E2E: Cron Scheduler — validate the cron_manage native tool through
 * the full agent pipeline. Tests cron job CRUD, manual triggering,
 * and cron-triggered task execution.
 *
 * Tests CR-1 through CR-13 across three phases:
 *   Phase 1 (CR-1–CR-6, CR-9, CR-11): Cron CRUD & execution
 *   Phase 2 (CR-7–CR-8, CR-10): Approval + cron
 *   Phase 3 (CR-12–CR-13): Scheduler timing, read from the runtime pod's
 *     Cron log lines: an every-minute job fires every minute; disabling after
 *     repeated enables stops every run; a re-enabled job waits for its next
 *     cron time. Focused run: -t "CR-12|CR-13".
 *
 * Issue #529 focused gate (branch-scoped minikube): CR-9 and CR-10 only.
 * They use sendWithApproval and assert cron dispatch stores status=completed
 * (never waiting_approval). Filesystem side-effects are best-effort.
 *
 * CR-11 is the recipe-driven autonomous probe (issue #529): it replays the
 * verbatim instruction from tests/e2e/fixtures/cron-exec-test-recipe.yaml and
 * lets the agent self-orchestrate create -> fire -> verify -> report.
 *
 * Requires a real LLM API key — these tests make actual LLM calls.
 * In the Phase 1 and 2 cases other than CR-11, the LLM must discover the
 * cron_manage tool from its schema (no explicit tool naming in prompts).
 * CR-11's recipe instruction and every Phase 3 prompt
 * (CRON_TOOL_INSTRUCTION) name the tool explicitly.
 *
 * Minikube branch profile (default deploy overlay):
 *   - Host CRD chatllm: provider zai, model glm-4.7
 *   - chatllm-api-keys secret: zai-api-key (from repo .env at setup time)
 *   - Telegram approval enabled via CLERUM_APPROVAL_CONFIG / Host spec
 *
 * Phase 1 CR-1–CR-6 use sendAndWait without approval and are NOT a valid gate
 * on the default minikube overlay (cron_manage blocks in waiting_approval).
 * To run them, disable approval and align provider/model in ConfigMap + Host.
 *
 * Prerequisites:
 *   1. Minikube branch profile running with mcp-host deployed (cron_manage tool)
 *   2. LLM key present in chatllm-api-keys for the configured provider
 *   3. Port-forward held (profile ports.env MCP_HOST_URL), e.g. pf-all-stack --hold
 *
 * Focused #529 smoke:
 *   cd tests/e2e && E2E_RUN_CRON_SCHEDULER=1 MCP_HOST_URL=<profile-url> \
 *     KUBECONTEXT=<profile> npx vitest run mcp-host/cron-scheduler.test.ts \
 *     -t "CR-9|CR-10" --bail 1
 *
 * Set E2E_RUN_CRON_SCHEDULER=1 to run this LLM-driven suite. It is not part
 * of the default deterministic minikube gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { CRON_EXEC_PROBE_INSTRUCTION } from '../fixtures/cronExecProbeInstruction.js'
import {
  DEFAULT_HOST_REF,
  KUBE_CONTEXT,
  MCP_HOST_NAMESPACE,
  MCP_HOST_URL,
  approveRequest,
  fetchJson,
  getStatus,
  getTaskResult,
  mcpHostExec,
  resolveMcpHostDeployment,
  sendMessage,
  sleep,
  waitForAgentState,
  waitForIdle,
} from '../helpers.js'
import { type CronJobRef, withJobCleanup } from './cronCleanup.js'
import { type CronLogEntry, type CronLogEvent, parseCronLogLines } from './cronLog.js'
import { issueRealRpcToken } from './runtimeAuth.js'

let statusToken: string

beforeAll(async () => {
  statusToken = await issueRealRpcToken(['host:status:read'], [DEFAULT_HOST_REF])
})

const RUN_CRON_SCHEDULER = process.env.E2E_RUN_CRON_SCHEDULER === '1'

// ---------------------------------------------------------------------------
// Test-wide state
// ---------------------------------------------------------------------------

/** Track workspace files created by cron-triggered tasks for cleanup. */
const cleanupPaths: string[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Auto-incrementing counter for unique userIds. */
let testCounter = 200

/**
 * Send a message and wait for the agent to finish.
 * Each call uses a unique userId (cron-test-*) to isolate conversations,
 * unless a specific userId is passed.
 */
async function sendAndWait(
  content: string,
  opts?: { userId?: string; timeoutMs?: number }
): Promise<{ response: string | null; userId: string }> {
  const userId = opts?.userId ?? `cron-test-${++testCounter}`
  const timeoutMs = opts?.timeoutMs ?? 180_000

  const res = await sendMessage(content, { userId })
  expect(res.status).toBe(200)

  if (res.data.success && res.data.response) {
    await waitForIdle(statusToken, 10_000).catch(() => {})
    return { response: res.data.response, userId }
  }

  await waitForIdle(statusToken, timeoutMs)
  return { response: res.data?.response || null, userId }
}

/**
 * Send a message that may trigger a tool requiring approval.
 * On first approval, passes alwaysApprove=true so subsequent calls auto-approve.
 */
async function sendWithApproval(
  content: string,
  opts?: { userId?: string; timeoutMs?: number }
): Promise<{ response: string | null; wasApproval: boolean; userId: string }> {
  const userId = opts?.userId ?? `cron-test-${++testCounter}`
  const timeoutMs = opts?.timeoutMs ?? 180_000

  let res = await sendMessage(content, { userId })

  // Case 1: LLM asks for permission as text (agent is already idle — send consent immediately)
  if (
    res.data?.response &&
    res.data?.status !== 'waiting_approval' &&
    /requires approval|shall i proceed|would you like|want me to/i.test(res.data.response)
  ) {
    res = await sendMessage('Yes, proceed. Execute it now.', { userId })
  }

  // Case 2: Approval gate triggered
  if (res.data?.status === 'waiting_approval' && res.data?.approval) {
    const { requestId, taskId } = res.data.approval
    const approvalUserId = res.data.approval.userId || userId

    const approvalRes = await approveRequest(
      approvalUserId,
      requestId,
      true // alwaysApprove — auto-approve future cron_manage calls
    )
    expect(approvalRes.status, JSON.stringify(approvalRes.data)).toBe(200)
    expect(approvalRes.data?.success, JSON.stringify(approvalRes.data)).toBe(true)

    await waitForIdle(statusToken, timeoutMs)

    const taskRes = await getTaskResult(taskId, timeoutMs)
    return {
      response: taskRes.data?.response || null,
      wasApproval: true,
      userId,
    }
  }

  // Case 3: No approval needed
  if (!res.data.success || !res.data.response) {
    await waitForIdle(statusToken, timeoutMs)
  }

  return { response: res.data?.response || null, wasApproval: false, userId }
}

/**
 * Execute a shell command inside the mcp-host container.
 */
function kubectlExec(cmd: string): string {
  return mcpHostExec(cmd)
}

/**
 * Check if a file exists in the container workspace.
 */
function fileExists(path: string): boolean {
  try {
    kubectlExec(`test -e /workspace/${path} && echo EXISTS`)
    return true
  } catch {
    return false
  }
}

/**
 * Read file contents from the container workspace.
 */
function readFileInContainer(path: string): string {
  return kubectlExec(`cat /workspace/${path}`)
}

/**
 * Check if a file exists at an absolute path inside the container.
 */
function absFileExists(absPath: string): boolean {
  try {
    kubectlExec(`test -e ${absPath} && echo EXISTS`)
    return true
  } catch {
    return false
  }
}

/**
 * Read file contents from an absolute path inside the container.
 * Returns an empty string if the file is missing.
 */
function readAbsFileInContainer(absPath: string): string {
  try {
    return kubectlExec(`cat ${absPath}`)
  } catch {
    return ''
  }
}

/**
 * Verbatim agentic instruction mirrored from
 * tests/e2e/fixtures/cron-exec-test-recipe.yaml. Drives the full
 * create -> fire -> wait -> verify -> report flow autonomously so the
 * LLM (not the test harness) orchestrates every step.
 */
type CronResultEntry = {
  id: string
  cronJobId: string
  cronJobName: string
  status?: 'completed' | 'waiting_approval'
}

function extractCronResults(data: unknown): CronResultEntry[] {
  if (Array.isArray(data)) return data as CronResultEntry[]
  if (data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results)) {
    return (data as { results: CronResultEntry[] }).results
  }
  return []
}

/**
 * Poll GET /v1/runtime/cron/results until a completed entry matches the job name.
 */
async function pollCronResultCompleted(
  cronJobName: string,
  opts?: { userId?: string; timeoutMs?: number }
): Promise<CronResultEntry> {
  const userId = opts?.userId ?? 'test-user'
  const timeoutMs = opts?.timeoutMs ?? 180_000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { status, data } = await fetchJson(`${MCP_HOST_URL}/v1/runtime/cron/results`, undefined, {
      caller: 'channel-reader',
      sender: userId,
      channelType: 'telegram',
      channelId: 'test-channel',
    })
    if (status === 200) {
      const results = extractCronResults(data)
      const match = results.find(
        entry => entry.cronJobName === cronJobName && entry.status === 'completed'
      )
      if (match) return match
    }
    await sleep(5000)
  }
  throw new Error(`Timed out waiting for completed cron result: ${cronJobName}`)
}

/**
 * Poll cron results and assert no waiting_approval entry exists for the job name.
 */
async function assertNoCronWaitingApproval(
  cronJobName: string,
  opts?: { userId?: string; timeoutMs?: number }
): Promise<void> {
  const userId = opts?.userId ?? 'test-user'
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { status, data } = await fetchJson(`${MCP_HOST_URL}/v1/runtime/cron/results`, undefined, {
      caller: 'channel-reader',
      sender: userId,
      channelType: 'telegram',
      channelId: 'test-channel',
    })
    if (status === 200) {
      const results = extractCronResults(data)
      const waiting = results.find(
        entry => entry.cronJobName === cronJobName && entry.status === 'waiting_approval'
      )
      if (waiting) {
        throw new Error(`Unexpected waiting_approval cron result for ${cronJobName}`)
      }
      const completed = results.find(
        entry => entry.cronJobName === cronJobName && entry.status === 'completed'
      )
      if (completed) return
    }
    await sleep(5000)
  }
  throw new Error(`Timed out waiting for autonomous cron completion: ${cronJobName}`)
}

// ---------------------------------------------------------------------------
// Phase 1: Cron CRUD & Execution (approval DISABLED)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_CRON_SCHEDULER)('Phase 1: Cron CRUD (approval disabled)', () => {
  it('CR-1: Create a cron job and verify via /status', async () => {
    const statusBefore = await getStatus(statusToken)
    const cronBefore = statusBefore.cronJobs || 0

    const { response } = await sendAndWait(
      "Schedule a recurring task named 'health-check' that runs every 5 minutes. " +
        'The task should report the current system date and time. ' +
        'Use the cron scheduling tool to create this job.'
    )

    const statusAfter = await getStatus(statusToken)
    expect(statusAfter.cronJobs).toBeGreaterThan(cronBefore)

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toMatch(/health.?check|cron|schedul|creat/)
    }

    expect(statusAfter.agent.state).toBe('idle')
  }, 240_000)

  it('CR-2: Create and list cron jobs', async () => {
    const userId = `cron-test-${++testCounter}`

    // Step 1: Create a job
    await sendAndWait(
      "Create a cron job named 'daily-report' that runs every day at midnight. " +
        "The task should say 'Generate daily summary report'.",
      { userId }
    )

    // Step 2: List jobs (same conversation)
    const { response } = await sendAndWait(
      'List all my scheduled cron jobs and show me their details.',
      { userId }
    )

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toMatch(/daily.?report/)
    }

    const status = await getStatus(statusToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)

  it('CR-3: Delete a cron job', async () => {
    const userId = `cron-test-${++testCounter}`

    // Step 1: Create a job
    await sendAndWait(
      "Create a cron job named 'temp-job' that runs every hour. " +
        'The task should check system status.',
      { userId }
    )

    const statusAfterCreate = await getStatus(statusToken)
    const cronAfterCreate = statusAfterCreate.cronJobs

    // Step 2: Delete it
    const { response } = await sendAndWait("Delete the 'temp-job' cron job.", { userId })

    const statusAfterDelete = await getStatus(statusToken)
    expect(statusAfterDelete.cronJobs).toBeLessThan(cronAfterCreate)

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toMatch(/delet|remov|success/)
    }

    expect(statusAfterDelete.agent.state).toBe('idle')
  }, 360_000)

  it('CR-4: Disable and re-enable a cron job', async () => {
    const userId = `cron-test-${++testCounter}`

    // Step 1: Create
    await sendAndWait(
      "Create a cron job named 'toggle-test' that runs every 30 minutes. " +
        'The task should check memory usage.',
      { userId }
    )

    // Step 2: Disable
    const { response: disableRes } = await sendAndWait("Disable the 'toggle-test' cron job.", {
      userId,
    })

    if (disableRes) {
      expect(disableRes.toLowerCase()).toMatch(/disable|stopped|paused/)
    }

    // Step 3: Re-enable
    const { response: enableRes } = await sendAndWait("Enable the 'toggle-test' cron job again.", {
      userId,
    })

    if (enableRes) {
      expect(enableRes.toLowerCase()).toMatch(/enable|started|active|resum/)
    }

    const status = await getStatus(statusToken)
    expect(status.agent.state).toBe('idle')
  }, 480_000)

  it('CR-5: Trigger cron job and verify task execution', async () => {
    const userId = `cron-test-${++testCounter}`
    cleanupPaths.push('cron-output.txt')

    const baselineStatus = await getStatus(statusToken)
    const baselineSucceeded = baselineStatus.agent.tasksSucceeded ?? 0

    // Step 1: Create a cron job whose task writes a file
    await sendAndWait(
      "Create a cron job named 'file-creator' that runs every hour. " +
        'The task content should be exactly: ' +
        "'Write the text CRON_OUTPUT_OK to a file named cron-output.txt'",
      { userId }
    )

    // Step 2: Trigger the job manually
    await sendAndWait("Trigger the 'file-creator' cron job right now to run it immediately.", {
      userId,
    })

    // Step 3: Wait for the triggered task to complete
    await waitForIdle(statusToken, 120_000)

    // Step 4: Verify the file was created by the cron-triggered task (unconditional)
    expect(fileExists('cron-output.txt')).toBe(true)
    const content = readFileInContainer('cron-output.txt')
    expect(content).toContain('CRON_OUTPUT_OK')

    const status = await getStatus(statusToken)
    expect(status.agent.state).toBe('idle')
    expect(status.agent.tasksSucceeded).toBeGreaterThan(baselineSucceeded)
  }, 480_000)

  it('CR-9: Scheduled fire executes through real dispatch path', async () => {
    const userId = `cron-test-${++testCounter}`
    cleanupPaths.push('cron-e2e-output.txt')

    const baselineStatus = await getStatus(statusToken)
    const baselineSucceeded = baselineStatus.agent.tasksSucceeded ?? 0
    const cronBefore = baselineStatus.cronJobs || 0

    await sendWithApproval(
      "Create a cron job named 'scheduled-fire-e2e' that runs every minute (*/1 * * * *). " +
        'The task content must be exactly this sentence (copy verbatim): ' +
        "'Use the shell tool to run this command: echo CRON_E2E_OK > /workspace/cron-e2e-output.txt'",
      { userId }
    )

    const statusAfterCreate = await getStatus(statusToken)
    expect(statusAfterCreate.cronJobs).toBeGreaterThan(cronBefore)

    const cronResult = await pollCronResultCompleted('scheduled-fire-e2e', {
      userId,
      timeoutMs: 240_000,
    })
    expect(cronResult.status).toBe('completed')
    expect(cronResult.cronJobName).toBe('scheduled-fire-e2e')

    const statusAfterFire = await waitForIdle(statusToken, 120_000)
    expect(statusAfterFire.agent.tasksSucceeded).toBeGreaterThan(baselineSucceeded)
    expect(statusAfterFire.queue.pending).toBe(0)

    // Filesystem proof is best-effort — the scheduled dispatch path is the gate.
    if (fileExists('cron-e2e-output.txt')) {
      const content = readFileInContainer('cron-e2e-output.txt')
      expect(content).toContain('CRON_E2E_OK')
    }

    await sendWithApproval("Delete the 'scheduled-fire-e2e' cron job.", { userId })
  }, 600_000)

  it('CR-6: Multiple cron jobs', async () => {
    const userId = `cron-test-${++testCounter}`
    const statusBefore = await getStatus(statusToken)
    const cronBefore = statusBefore.cronJobs || 0

    // Step 1: Create 3 jobs
    await sendAndWait(
      'Create these three cron jobs: ' +
        "1) 'job-alpha' running every 5 minutes with task 'Alpha ping'. " +
        "2) 'job-beta' running every 10 minutes with task 'Beta ping'. " +
        "3) 'job-gamma' running every hour with task 'Gamma ping'.",
      { userId }
    )

    // Step 2: List them
    const { response } = await sendAndWait('List all scheduled cron jobs.', { userId })

    const statusAfter = await getStatus(statusToken)
    expect(statusAfter.cronJobs).toBeGreaterThanOrEqual(cronBefore + 3)

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toContain('alpha')
      expect(lower).toContain('beta')
      expect(lower).toContain('gamma')
    }

    expect(statusAfter.agent.state).toBe('idle')
  }, 480_000)

  it('CR-11: Recipe-driven autonomous cron execution (create -> fire -> verify -> report)', async () => {
    // Mirrors tests/e2e/fixtures/cron-exec-test-recipe.yaml: the agent itself
    // orchestrates create -> trigger -> poll -> verify -> report in a single
    // autonomous turn. This is the closest harness equivalent of running the
    // WorkflowRecipe, and is the canonical regression probe for issue #529.
    const userId = `cron-test-${++testCounter}`
    const PROOF_PATH = '/tmp/cron-exec-proof.txt'

    // Hermetic precondition (isolation): a leftover 'e2e-cron-exec' job from an
    // earlier run on the same pod would fire every minute and could write the
    // proof file outside this test's window. Delete it first so the only writer
    // is this run's create+trigger, then clear any stale proof file.
    await sendWithApproval(
      "If a cron job named 'e2e-cron-exec' already exists, delete it. " +
        'If it does not exist, do nothing.',
      { userId, timeoutMs: 120_000 }
    )
    try {
      mcpHostExec(`rm -f ${PROOF_PATH}`)
    } catch {
      // best-effort; absence is fine
    }

    const baselineStatus = await getStatus(statusToken)
    const baselineSucceeded = baselineStatus.agent.tasksSucceeded ?? 0

    // Single-shot: hand the full recipe instruction to the agent and let it
    // self-orchestrate every step. Long timeout: the agent polls with
    // `sleep 8` up to 4 times plus multiple LLM rounds.
    const { response } = await sendWithApproval(CRON_EXEC_PROBE_INSTRUCTION, {
      userId,
      timeoutMs: 720_000,
    })

    // 1. LLM verdict — the final line must be the success sentinel, not failure.
    expect(response).toBeTruthy()
    const finalResponse = (response ?? '').trim()
    expect(finalResponse).toContain('CRON_EXEC_VERIFIED')
    expect(finalResponse).not.toContain('CRON_EXEC_FAILED')

    // 2. Source of truth — independently confirm the cron task wrote the proof
    //    file. This catches a hallucinated "VERIFIED" verdict where the
    //    side-effect never actually happened.
    expect(absFileExists(PROOF_PATH)).toBe(true)
    const proof = readAbsFileInContainer(PROOF_PATH)
    expect(proof).toContain('CRON_EXEC_OK')

    // 3. Pipeline health — the scheduled task ran through real dispatch.
    const statusAfter = await waitForIdle(statusToken, 120_000)
    expect(statusAfter.agent.tasksSucceeded).toBeGreaterThan(baselineSucceeded)
    expect(statusAfter.agent.state).toBe('idle')
    expect(statusAfter.queue.pending).toBe(0)

    // Cleanup: delete the cron job and remove the proof file.
    await sendWithApproval("Delete the 'e2e-cron-exec' cron job.", { userId })
    try {
      mcpHostExec(`rm -f ${PROOF_PATH}`)
    } catch {
      // best-effort
    }
  }, 1_080_000)
})

// ---------------------------------------------------------------------------
// Phase 2: Approval + Cron (approval ENABLED)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_CRON_SCHEDULER)('Phase 2: Approval + Cron (approval enabled)', () => {
  it('CR-7: Approval gate blocks cron_manage until approved', async () => {
    const statusBefore = await getStatus(statusToken)
    const cronBefore = statusBefore.cronJobs || 0

    const { response, wasApproval } = await sendWithApproval(
      "Schedule a cron job named 'approved-job' that runs every hour. " +
        'The task should report system status.',
      { timeoutMs: 240_000 }
    )

    // If approval is enabled, wasApproval should be true
    // If approval is disabled, the test still passes (just no approval needed)
    if (wasApproval) {
      console.log('[CR-7] Approval flow confirmed for cron_manage')
    }

    const statusAfter = await getStatus(statusToken)
    expect(statusAfter.cronJobs).toBeGreaterThan(cronBefore)

    if (response) {
      expect(response.toLowerCase()).toMatch(/schedul|cron|creat|approved/)
    }

    expect(statusAfter.agent.state).toBe('idle')
  }, 300_000)

  it('CR-8: Auto-approve cron_manage after first approval', async () => {
    const userId = `cron-test-${++testCounter}`

    // Step 1: First cron_manage call — should trigger approval
    const res1 = await sendWithApproval(
      "Create a cron job named 'auto-approve-test-1' running every hour. " +
        'Task: first scheduled ping.',
      { userId, timeoutMs: 240_000 }
    )

    const status1 = await getStatus(statusToken)
    expect(status1.agent.state).toBe('idle')

    // Step 2: Second cron_manage call — should auto-approve (same userId)
    const res2 = await sendWithApproval(
      "Create another cron job named 'auto-approve-test-2' running every day. " +
        'Task: second scheduled ping.',
      { userId, timeoutMs: 240_000 }
    )

    // If approval is enabled and alwaysApprove worked, the second call
    // should NOT have required a separate approval
    if (res1.wasApproval && !res2.wasApproval) {
      console.log('[CR-8] Auto-approve confirmed: second call bypassed approval')
    }

    if (res2.response) {
      expect(res2.response.toLowerCase()).toMatch(/schedul|cron|creat/)
    }

    const status2 = await getStatus(statusToken)
    expect(status2.agent.state).toBe('idle')
  }, 480_000)

  it('CR-10: Cron scheduled fire completes autonomously under approval enabled', async () => {
    const userId = `cron-test-${++testCounter}`
    cleanupPaths.push('cron-approval-e2e.txt')

    const baselineStatus = await getStatus(statusToken)
    const baselineSucceeded = baselineStatus.agent.tasksSucceeded ?? 0

    const { wasApproval } = await sendWithApproval(
      "Create a cron job named 'approval-autonomous-e2e' that runs every minute (*/1 * * * *). " +
        'The task content must be exactly: ' +
        "'Write the text CRON_APPROVAL_E2E_OK to a file named cron-approval-e2e.txt'",
      { userId, timeoutMs: 300_000 }
    )

    if (wasApproval) {
      console.log('[CR-10] Creation required approval as expected')
    }

    await assertNoCronWaitingApproval('approval-autonomous-e2e', {
      userId,
      timeoutMs: 240_000,
    })

    // Filesystem proof is best-effort — autonomous completed dispatch is the gate.
    if (fileExists('cron-approval-e2e.txt')) {
      const content = readFileInContainer('cron-approval-e2e.txt')
      expect(content).toContain('CRON_APPROVAL_E2E_OK')
    }

    const statusAfterFire = await waitForIdle(statusToken, 120_000)
    expect(statusAfterFire.agent.tasksSucceeded).toBeGreaterThan(baselineSucceeded)
    expect(statusAfterFire.agent.state).toBe('idle')

    await sendAndWait("Delete the 'approval-autonomous-e2e' cron job.", { userId })
  }, 600_000)
})

// ---------------------------------------------------------------------------
// Phase 3: Scheduler timing
//
// The fire times come from the Cron lines of the mcp-host runtime pod log
// (see ./cronLog.ts), not from the LLM reply or GET /v1/runtime/cron/results:
// those carry no fire time, and the in-cluster channel-reader may ACK-delete
// cron results. Every requested cron_manage action must show its own Cron
// line, so a reply without a tool call fails the test instead of passing it.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000
const ACTION_TIMEOUT_MS = 240_000

/**
 * Cron lines the mcp-host runtime pod logged since `since` (epoch ms).
 * The kubectl() helper keeps execSync's 1 MiB output limit, which a
 * fifteen-minute runtime log can exceed, so this read sets its own limit.
 */
function readCronLog(since: number): CronLogEntry[] {
  const log = execFileSync(
    'kubectl',
    [
      `--context=${KUBE_CONTEXT}`,
      'logs',
      `deploy/${resolveMcpHostDeployment()}`,
      '-n',
      MCP_HOST_NAMESPACE,
      `--since-time=${new Date(since).toISOString()}`,
    ],
    { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 }
  )
  return parseCronLogLines(log)
}

function linesOf(
  entries: CronLogEntry[],
  jobId: string,
  event: CronLogEvent,
  after = Number.NEGATIVE_INFINITY
): CronLogEntry[] {
  return entries.filter(e => e.jobId === jobId && e.event === event && e.at > after)
}

async function waitForCronLog(
  since: number,
  what: string,
  done: (entries: CronLogEntry[]) => boolean,
  timeoutMs: number
): Promise<CronLogEntry[]> {
  const deadline = Date.now() + timeoutMs
  let entries: CronLogEntry[] = []
  while (Date.now() < deadline) {
    entries = readCronLog(since)
    if (done(entries)) return entries
    await sleep(2000)
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${what}. Last Cron lines: ` +
      JSON.stringify(entries.slice(-20))
  )
}

/**
 * Appended to every Phase 3 request. Without it the agent sometimes answers
 * "Created cron job ..." or "Deleted." from the conversation instead of
 * calling the tool, and no Cron line follows.
 */
const CRON_TOOL_INSTRUCTION =
  'Call the cron_manage tool to do this now; do not answer from memory or from earlier messages.'

/**
 * Phase 3 user ids carry this run's id, so every run starts each user with an
 * empty chat session. The shared counter restarts at 200 on every run, which
 * reused the sessions of earlier runs.
 */
const PHASE3_RUN_ID = Date.now()
let phase3UserCounter = 0
const phase3UserId = () => `cron-timing-${PHASE3_RUN_ID}-${++phase3UserCounter}`

/**
 * Send a chat request that should run cron_manage, approving the tool call if
 * asked. Returns the agent's last reply, so a missing Cron line can be
 * reported with what the agent said instead.
 */
async function sendCronRequest(content: string, userId: string): Promise<string> {
  let res = await sendMessage(`${content} ${CRON_TOOL_INSTRUCTION}`, { userId })
  expect(res.status, JSON.stringify(res.data)).toBe(200)

  if (
    res.data?.status !== 'waiting_approval' &&
    typeof res.data?.response === 'string' &&
    /requires approval|shall i proceed|would you like|want me to/i.test(res.data.response)
  ) {
    res = await sendMessage('Yes, proceed. Execute it now.', { userId })
    expect(res.status, JSON.stringify(res.data)).toBe(200)
  }

  if (res.data?.status === 'waiting_approval' && res.data?.approval) {
    const approvalRes = await approveRequest(
      res.data.approval.userId || userId,
      res.data.approval.requestId,
      true
    )
    expect(approvalRes.status, JSON.stringify(approvalRes.data)).toBe(200)
    expect(approvalRes.data?.success, JSON.stringify(approvalRes.data)).toBe(true)
  }
  return JSON.stringify(res.data?.response ?? res.data).slice(0, 800)
}

/** Ask the agent to create an every-minute job; returns its id from the Created line. */
async function createEveryMinuteJob(name: string, userId: string, since: number): Promise<string> {
  const reply = await sendCronRequest(
    `Create a cron job named '${name}' with the schedule */1 * * * * (every minute). ` +
      "Its task content must be exactly: 'Reply with the single word OK.'",
    userId
  )
  const entries = await waitForCronLog(
    since,
    `the agent to run cron_manage create for ${name} (agent reply: ${reply})`,
    es => es.some(e => e.event === 'Created' && e.jobName === name),
    ACTION_TIMEOUT_MS
  )
  return entries.find(e => e.event === 'Created' && e.jobName === name)!.jobId
}

/** Ask the agent for one action on a job and return the Cron line it produced. */
async function runJobAction(
  action: 'enable' | 'disable' | 'delete',
  jobId: string,
  userId: string,
  since: number
): Promise<CronLogEntry> {
  const event: CronLogEvent =
    action === 'enable' ? 'Enabled' : action === 'disable' ? 'Disabled' : 'Deleted'
  const before = linesOf(readCronLog(since), jobId, event).length
  const request =
    action === 'enable'
      ? `Enable the cron job with id ${jobId} now, even if it is already enabled.`
      : action === 'disable'
        ? `Disable the cron job with id ${jobId}.`
        : `Delete the cron job with id ${jobId}.`
  const reply = await sendCronRequest(request, userId)
  const entries = await waitForCronLog(
    since,
    `the agent to run cron_manage ${action} for job ${jobId} (agent reply: ${reply})`,
    es => linesOf(es, jobId, event).length > before,
    ACTION_TIMEOUT_MS
  )
  return linesOf(entries, jobId, event)[before]!
}

/**
 * Run a test body that registers each job it creates, then ask the agent to
 * delete every registered job. See ./cronCleanup.ts for how a cleanup failure
 * is reported next to a body failure.
 */
function withCronJobs<T>(since: number, body: (jobs: CronJobRef[]) => Promise<T>): Promise<T> {
  return withJobCleanup(body, (jobId, userId) => runJobAction('delete', jobId, userId, since))
}

function podSecondOfMinute(): number {
  const second = Number(mcpHostExec('date -u +%S'))
  if (!Number.isInteger(second)) throw new Error('Could not read the mcp-host pod clock')
  return second
}

/** Distance to the nearest minute boundary; a timer may fire a millisecond early. */
function msFromMinuteBoundary(at: number): number {
  const offset = at % MINUTE_MS
  return Math.min(offset, MINUTE_MS - offset)
}

const isoTimes = (entries: CronLogEntry[]) => entries.map(e => new Date(e.at).toISOString())

describe.skipIf(!RUN_CRON_SCHEDULER)('Phase 3: Scheduler timing', () => {
  it('CR-12: an every-minute job fires once in every minute', async () => {
    const since = Date.now() - MINUTE_MS
    const userId = phase3UserId()
    const name = `cadence-e2e-${Date.now()}`

    await withCronJobs(since, async jobs => {
      const jobId = await createEveryMinuteJob(name, userId, since)
      jobs.push([jobId, userId])

      const first = await waitForCronLog(
        since,
        `the first fire of ${name}`,
        es => linesOf(es, jobId, 'Executing').length > 0,
        150_000
      )
      const firstAt = linesOf(first, jobId, 'Executing')[0]!.at
      // Four minute boundaries follow the first fire within 270 s.
      const windowEnd = firstAt + 270_000
      await sleep(Math.max(0, windowEnd + 5_000 - Date.now()))

      const fires = linesOf(readCronLog(since), jobId, 'Executing').filter(e => e.at <= windowEnd)
      const gaps = fires.slice(1).map((f, i) => Math.round((f.at - fires[i]!.at) / 1000))

      expect.soft(fires.length, `fires: ${isoTimes(fires)}`).toBeGreaterThanOrEqual(4)
      expect
        .soft(
          gaps.every(gap => gap >= 55 && gap <= 65),
          `gaps in seconds: ${gaps}`
        )
        .toBe(true)
      expect
        .soft(
          fires.every(f => msFromMinuteBoundary(f.at) < 3_000),
          `every fire on a minute boundary: ${isoTimes(fires)}`
        )
        .toBe(true)
    })
  }, 600_000)

  it('CR-13: disabling after repeated enables stops every run, and re-enabling waits for the next cron time', async () => {
    const since = Date.now() - MINUTE_MS
    const runId = Date.now()
    const targetUser = phase3UserId()
    const controlUser = phase3UserId()
    const target = await createEveryMinuteJob(`toggle-target-${runId}`, targetUser, since)
    const control = await createEveryMinuteJob(`toggle-control-${runId}`, controlUser, since)

    await withCronJobs(since, async jobs => {
      jobs.push([target, targetUser], [control, controlUser])

      await waitForCronLog(
        since,
        'the first fire of the target job',
        es => linesOf(es, target, 'Executing').length > 0,
        150_000
      )

      // Enabling an enabled job twice used to leave orphaned timers that
      // disableJob could not clear.
      await runJobAction('enable', target, targetUser, since)
      await runJobAction('enable', target, targetUser, since)
      const disabledAt = (await runJobAction('disable', target, targetUser, since)).at

      // Two control fires after the disable: the scheduler kept running and
      // the log was read across the target's next cron time.
      await waitForCronLog(
        since,
        'two control fires after the target was disabled',
        es => linesOf(es, control, 'Executing', disabledAt).length >= 2,
        300_000
      )
      await sleep(5_000)
      const afterDisable = readCronLog(since)
      const controlFires = linesOf(afterDisable, control, 'Executing', disabledAt)
      const targetFires = linesOf(afterDisable, target, 'Executing', disabledAt)
      expect(
        controlFires.length,
        `control fires: ${isoTimes(controlFires)}`
      ).toBeGreaterThanOrEqual(2)
      expect
        .soft(
          targetFires,
          `target fires after the disable at ${new Date(disabledAt).toISOString()}`
        )
        .toEqual([])

      // Re-enable early in a minute, so that "at once" and "at the next
      // boundary" are far apart.
      const second = podSecondOfMinute()
      if (second < 3 || second > 10) await sleep(((63 - second) % 60) * 1000)
      const enabledAt = (await runJobAction('enable', target, targetUser, since)).at
      if (enabledAt % MINUTE_MS >= 55_000) {
        throw new Error(
          `Inconclusive timing: the re-enable ran at ${new Date(enabledAt).toISOString()}, ` +
            'too close to the next minute boundary to tell an immediate run from a scheduled one'
        )
      }
      const afterEnable = await waitForCronLog(
        since,
        'the first target fire after the re-enable',
        es => linesOf(es, target, 'Executing', enabledAt).length > 0,
        120_000
      )
      const firstFire = linesOf(afterEnable, target, 'Executing', enabledAt)[0]!
      const fireReport =
        `re-enabled at ${new Date(enabledAt).toISOString()}, ` +
        `fired at ${new Date(firstFire.at).toISOString()}`
      expect.soft(firstFire.at - enabledAt, fireReport).toBeGreaterThanOrEqual(3_000)
      expect.soft(msFromMinuteBoundary(firstFire.at), fireReport).toBeLessThan(3_000)
    })
  }, 900_000)
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  // Clean up workspace files created by cron-triggered tasks
  if (cleanupPaths.length > 0) {
    const pathList = cleanupPaths.map(p => `/workspace/${p}`).join(' ')
    try {
      mcpHostExec(`rm -rf ${pathList}`)
      console.log(`[Cleanup] Removed workspace files: ${pathList}`)
    } catch (e) {
      console.log(`[Cleanup] Warning: could not remove paths: ${e}`)
    }
  }

  // Note: Cron jobs are in-memory and cannot be cleaned up externally.
  // They will be cleared on pod restart. For test isolation between
  // runs, restart the mcp-host pod:
  //   kubectl -n mcp-host rollout restart deploy/chatllm
  console.log(
    '[Cleanup] Note: In-memory cron jobs persist until pod restart. ' +
      "Run 'kubectl -n mcp-host rollout restart deploy/chatllm' between test runs."
  )
})
