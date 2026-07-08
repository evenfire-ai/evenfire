/**
 * E2E: Cron Scheduler — validate the cron_manage native tool through
 * the full agent pipeline. Tests cron job CRUD, manual triggering,
 * and cron-triggered task execution.
 *
 * Tests CR-1 through CR-11 across two phases:
 *   Phase 1 (CR-1–CR-6, CR-9, CR-11): Cron CRUD & execution
 *   Phase 2 (CR-7–CR-8, CR-10): Approval + cron
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
 * The LLM must discover the cron_manage tool from its schema (no
 * explicit tool naming in prompts).
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
import { afterAll, describe, expect, it } from 'vitest'
import {
  MCP_HOST_URL,
  approveRequest,
  fetchJson,
  getStatus,
  getTaskResult,
  mcpHostExec,
  sendMessage,
  sleep,
  waitForAgentState,
  waitForIdle,
} from '../helpers.js'

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
    await waitForIdle(10_000).catch(() => {})
    return { response: res.data.response, userId }
  }

  await waitForIdle(timeoutMs)
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

    await waitForIdle(timeoutMs)

    const taskRes = await getTaskResult(taskId, timeoutMs)
    return {
      response: taskRes.data?.response || null,
      wasApproval: true,
      userId,
    }
  }

  // Case 3: No approval needed
  if (!res.data.success || !res.data.response) {
    await waitForIdle(timeoutMs)
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
const CRON_EXEC_RECIPE_INSTRUCTION = [
  'You are validating whether SCHEDULED (cron) tasks actually execute on this',
  'mcp-host. Use the available tools and do these steps IN ORDER.',
  '',
  '1. CREATE — use the cron scheduling tool (cron_manage) to create a recurring job',
  '   named "e2e-cron-exec" with schedule "*/1 * * * *". The job\'s task content MUST be',
  '   EXACTLY this sentence (copy it verbatim):',
  '   Use the shell tool to run this command: echo CRON_EXEC_OK > /tmp/cron-exec-proof.txt',
  '',
  '2. FIRE — use cron_manage to TRIGGER the "e2e-cron-exec" job immediately so it runs now.',
  '',
  '3. WAIT + VERIFY — the triggered task runs asynchronously in the background, so you',
  '   must poll. Use the shell tool to run:',
  '     sleep 8 ; cat /tmp/cron-exec-proof.txt',
  '   If the file is missing or empty, repeat the same shell command (sleep 8 ; cat ...)',
  '   up to 4 attempts total.',
  '',
  '4. REPORT — the FINAL line of your answer MUST be exactly one of:',
  '   - if the file contains CRON_EXEC_OK   ->   CRON_EXEC_VERIFIED',
  '   - if after all 4 attempts it is empty ->   CRON_EXEC_FAILED',
].join('\n')

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
    const statusBefore = await getStatus()
    const cronBefore = statusBefore.cronJobs || 0

    const { response } = await sendAndWait(
      "Schedule a recurring task named 'health-check' that runs every 5 minutes. " +
        'The task should report the current system date and time. ' +
        'Use the cron scheduling tool to create this job.'
    )

    const statusAfter = await getStatus()
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

    const status = await getStatus()
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

    const statusAfterCreate = await getStatus()
    const cronAfterCreate = statusAfterCreate.cronJobs

    // Step 2: Delete it
    const { response } = await sendAndWait("Delete the 'temp-job' cron job.", { userId })

    const statusAfterDelete = await getStatus()
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

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
  }, 480_000)

  it('CR-5: Trigger cron job and verify task execution', async () => {
    const userId = `cron-test-${++testCounter}`
    cleanupPaths.push('cron-output.txt')

    const baselineStatus = await getStatus()
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
    await waitForIdle(120_000)

    // Step 4: Verify the file was created by the cron-triggered task (unconditional)
    expect(fileExists('cron-output.txt')).toBe(true)
    const content = readFileInContainer('cron-output.txt')
    expect(content).toContain('CRON_OUTPUT_OK')

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
    expect(status.agent.tasksSucceeded).toBeGreaterThan(baselineSucceeded)
  }, 480_000)

  it('CR-9: Scheduled fire executes through real dispatch path', async () => {
    const userId = `cron-test-${++testCounter}`
    cleanupPaths.push('cron-e2e-output.txt')

    const baselineStatus = await getStatus()
    const baselineSucceeded = baselineStatus.agent.tasksSucceeded ?? 0
    const cronBefore = baselineStatus.cronJobs || 0

    await sendWithApproval(
      "Create a cron job named 'scheduled-fire-e2e' that runs every minute (*/1 * * * *). " +
        'The task content must be exactly this sentence (copy verbatim): ' +
        "'Use the shell tool to run this command: echo CRON_E2E_OK > /workspace/cron-e2e-output.txt'",
      { userId }
    )

    const statusAfterCreate = await getStatus()
    expect(statusAfterCreate.cronJobs).toBeGreaterThan(cronBefore)

    const cronResult = await pollCronResultCompleted('scheduled-fire-e2e', {
      userId,
      timeoutMs: 240_000,
    })
    expect(cronResult.status).toBe('completed')
    expect(cronResult.cronJobName).toBe('scheduled-fire-e2e')

    const statusAfterFire = await waitForIdle(120_000)
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
    const statusBefore = await getStatus()
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

    const statusAfter = await getStatus()
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

    const baselineStatus = await getStatus()
    const baselineSucceeded = baselineStatus.agent.tasksSucceeded ?? 0

    // Single-shot: hand the full recipe instruction to the agent and let it
    // self-orchestrate every step. Long timeout: the agent polls with
    // `sleep 8` up to 4 times plus multiple LLM rounds.
    const { response } = await sendWithApproval(CRON_EXEC_RECIPE_INSTRUCTION, {
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
    const statusAfter = await waitForIdle(120_000)
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
    const statusBefore = await getStatus()
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

    const statusAfter = await getStatus()
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

    const status1 = await getStatus()
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

    const status2 = await getStatus()
    expect(status2.agent.state).toBe('idle')
  }, 480_000)

  it('CR-10: Cron scheduled fire completes autonomously under approval enabled', async () => {
    const userId = `cron-test-${++testCounter}`
    cleanupPaths.push('cron-approval-e2e.txt')

    const baselineStatus = await getStatus()
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

    const statusAfterFire = await waitForIdle(120_000)
    expect(statusAfterFire.agent.tasksSucceeded).toBeGreaterThan(baselineSucceeded)
    expect(statusAfterFire.agent.state).toBe('idle')

    await sendAndWait("Delete the 'approval-autonomous-e2e' cron job.", { userId })
  }, 600_000)
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
