/**
 * E2E: Software Creation — validate the Clerum agent can create, build, and
 * test software end-to-end through multi-step tool-use chains.
 *
 * Tests SC-1 through SC-11 from docs/archive/testing/E2E-SOFTWARE-CREATION-PLAN.md.
 * Requires a REAL LLM API key (OpenAI or Claude) — these tests make actual
 * LLM calls and exercise multi-step tool orchestration.
 *
 * Prerequisites:
 *   1. Minikube running with mcp-host deployed (image with /workspace dir)
 *   2. Real OPENAI_API_KEY (or CLAUDE_API_KEY) in chatllm-api-keys secret
 *   3. ConfigMap tuned for software creation:
 *        CLERUM_ENABLE_APPROVAL=false
 *        CLERUM_AGENT_MAX_TOOL_CALLS=200
 *        CLERUM_AGENT_MAX_TASK_DURATION=1200000
 *        CLERUM_SHELL_TIMEOUT=120000
 *   4. Port-forwarding active:
 *        kubectl port-forward -n mcp-host svc/chatllm 8080:8080
 *   5. Auth-chain synchronized:
 *        make minikube-sync-auth-key
 *        CONTEXT=clerum-test E2E_DEV_LOGIN_EMAIL=test@clerum.io scripts/minikube/seed-test-data.sh
 *
 * Run:
 *   cd tests/e2e && npx vitest run software-creation.test.ts
 */
import { afterAll, describe as baseDescribe, beforeAll, expect, it } from 'vitest'
import {
  getRpcHostStatus,
  getRpcTaskResult,
  issueRealRpcToken,
  kubectlExecInChatllm,
  sendRpcHostMessage,
  waitForRpcHostIdle,
} from './runtimeAuth.js'

// ---------------------------------------------------------------------------
// Test-wide state
// ---------------------------------------------------------------------------

/** Track files/directories created during tests for cleanup. */
const cleanupPaths: string[] = []
let authToken = ''
const RUN_SOFTWARE_CREATION = /^(1|true|yes)$/i.test(process.env.E2E_RUN_SOFTWARE_CREATION ?? '')
const describe = baseDescribe.skipIf(!RUN_SOFTWARE_CREATION)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Auto-incrementing counter to give each test a unique userId (isolated conversation). */
let testCounter = 0

/**
 * Send a message and wait for the agent to finish, handling the hardcoded
 * 5-minute HTTP timeout in the /message endpoint.
 *
 * Each call uses a unique userId to prevent conversation context accumulation
 * from prior tests confusing the LLM.
 *
 * Returns the response text if available, or null if the HTTP timed out
 * (the agent may still be completing in the background).
 */
async function sendAndWait(
  content: string,
  timeoutMs: number = 300_000
): Promise<{ response: string | null; timedOut: boolean }> {
  testCounter++
  const userId = `sc-test-${testCounter}`

  const res = await sendRpcHostMessage(authToken, content, {
    userId,
    async: true,
  })
  expect(res.status).toBe(200)

  if (typeof res.data?.taskId === 'string' && res.data.taskId.length > 0) {
    const result = await getRpcTaskResult(authToken, res.data.taskId, timeoutMs)
    await waitForRpcHostIdle(authToken, 10_000).catch(() => {})
    return {
      response: typeof result.data?.response === 'string' ? result.data.response : null,
      timedOut: false,
    }
  }

  if (typeof res.data?.response === 'string') {
    await waitForRpcHostIdle(authToken, 10_000).catch(() => {})
    return { response: res.data.response, timedOut: false }
  }

  await waitForRpcHostIdle(authToken, timeoutMs)
  return { response: res.data?.response || null, timedOut: true }
}

/**
 * Execute a shell command inside the mcp-host container.
 * Returns stdout. Throws if the command fails.
 */
function kubectlExec(cmd: string): string {
  return kubectlExecInChatllm(cmd)
}

/**
 * Check if a file or directory exists in the container workspace.
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

function isExecutableInContainer(path: string): boolean {
  try {
    kubectlExec(`test -x /workspace/${path} && echo EXECUTABLE`)
    return true
  } catch {
    return false
  }
}

function runNodeFile(path: string): string {
  return kubectlExec(`cd /workspace && node ${path} 2>&1`)
}

function expectWorkspaceEntry(path: string, response: string | null): void {
  expect(
    fileExists(path),
    [
      `Expected agent to create /workspace/${path}, but it was missing.`,
      "This suite validates real artifact creation inside chatllm, not only the model's natural-language claim.",
      `Agent response: ${response ?? '<empty>'}`,
    ].join('\n\n')
  ).toBe(true)
}

beforeAll(async () => {
  if (!RUN_SOFTWARE_CREATION) return

  // These tests are intentionally strict: they verify the real user -> rpc token
  // -> rpc-proxy -> mcp-host path, not a bypass token or a mocked host.
  authToken = await issueRealRpcToken(
    [
      'host:message:invoke',
      'host:status:read',
      'host:task:read',
      'host:activity:read',
      'host:approval:write',
    ],
    ['chatllm']
  )

  const status = await getRpcHostStatus(authToken)
  expect(status).toBeTruthy()
  await waitForRpcHostIdle(authToken, 10_000).catch(() => {})
}, 60_000)

function normalizeLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

function countTextStats(text: string): {
  lines: number
  words: number
  characters: number
} {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.length === 0 ? 0 : normalized.split('\n').length
  const words = normalized.trim().length === 0 ? 0 : normalized.trim().split(/\s+/).length
  return {
    lines,
    words,
    characters: normalized.length,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Single File Creation
// ---------------------------------------------------------------------------

describe('Phase 1: Single File Creation', () => {
  it('SC-1: shell script — create, chmod, execute', async () => {
    cleanupPaths.push('hello.sh')

    const { response } = await sendAndWait(
      "Create a shell script called hello.sh that prints 'Hello Clerum' and the current date. Make it executable and run it. Tell me the output.",
      300_000
    )

    // Verify file was created
    expectWorkspaceEntry('hello.sh', response)
    expect(isExecutableInContainer('hello.sh')).toBe(true)

    const output = kubectlExec('cd /workspace && ./hello.sh')
    expect(output.toLowerCase()).toContain('hello clerum')

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toContain('hello clerum')
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)

  it('SC-2: Node.js FizzBuzz — code generation and execution', async () => {
    cleanupPaths.push('fizzbuzz.js')

    const { response } = await sendAndWait(
      'Write a Node.js script called fizzbuzz.js that prints FizzBuzz for numbers 1 to 20, then run it with node and tell me the output.',
      300_000
    )

    expectWorkspaceEntry('fizzbuzz.js', response)

    const output = normalizeLines(runNodeFile('fizzbuzz.js'))
    expect(output).toEqual([
      '1',
      '2',
      'Fizz',
      '4',
      'Buzz',
      'Fizz',
      '7',
      '8',
      'Fizz',
      'Buzz',
      '11',
      'Fizz',
      '13',
      '14',
      'FizzBuzz',
      '16',
      '17',
      'Fizz',
      '19',
      'Buzz',
    ])

    if (response) {
      const responseTokens =
        response
          .match(/\d+|FizzBuzz|Fizz|Buzz/gi)
          ?.map(token =>
            /^\d+$/.test(token) ? token : token[0].toUpperCase() + token.slice(1).toLowerCase()
          ) ?? []
      expect(responseTokens.slice(0, output.length)).toEqual(output)
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)

  it('SC-3: Node.js factorial — compute and report', async () => {
    cleanupPaths.push('calc.js')

    const { response } = await sendAndWait(
      'Create a Node.js script called calc.js that computes the factorial of 10 and prints the result. Run it and tell me the answer.',
      300_000
    )

    expectWorkspaceEntry('calc.js', response)

    const output = runNodeFile('calc.js').trim()
    expect(output).toBe('3628800')

    if (response) {
      expect(response).toContain('3628800')
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)
})

// ---------------------------------------------------------------------------
// Phase 2: Multi-File Projects
// ---------------------------------------------------------------------------

describe('Phase 2: Multi-File Projects', () => {
  it('SC-4: Node.js module — multi-file with require', async () => {
    cleanupPaths.push('mathlib')

    const { response } = await sendAndWait(
      "Use the file_write tool to create these files, then use shell_exec to run the code: 1) Use file_write to create mathlib/utils.js that exports functions 'add(a,b)' and 'multiply(a,b)'. 2) Use file_write to create mathlib/index.js that requires both functions from ./utils.js and prints add(3,4) and multiply(5,6). 3) Use shell_exec to run 'node mathlib/index.js' and tell me the results.",
      300_000
    )

    expectWorkspaceEntry('mathlib/utils.js', response)
    expectWorkspaceEntry('mathlib/index.js', response)

    const output = normalizeLines(kubectlExec('cd /workspace && node mathlib/index.js'))
    expect(output).toEqual(['7', '30'])

    if (response) {
      const responseNumbers = response.match(/\b\d+\b/g)?.map(Number) ?? []
      expect(responseNumbers).toEqual(expect.arrayContaining([7, 30]))
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)

  it('SC-5: static site — HTML + CSS + JS in a folder', async () => {
    cleanupPaths.push('site')

    const { response } = await sendAndWait(
      "Use the file_write tool to create all three files: 1) Use file_write to create site/index.html — an HTML page with title 'Clerum Test Site', a link to style.css, a script tag for app.js, and a div with id 'output'. 2) Use file_write to create site/style.css — styles the body with a blue background and white text. 3) Use file_write to create site/app.js — sets document.getElementById('output').innerText to 'Site loaded successfully'. After creating all files, use shell_exec to run 'ls site/' and confirm they exist.",
      300_000
    )

    // Verify all three files were created
    expectWorkspaceEntry('site/index.html', response)
    expectWorkspaceEntry('site/style.css', response)
    expectWorkspaceEntry('site/app.js', response)

    // Verify HTML content references CSS and JS
    const html = readFileInContainer('site/index.html')
    expect(html).toContain('style.css')
    expect(html).toContain('app.js')
    expect(html.toLowerCase()).toContain('clerum test site')

    // Verify CSS has blue-ish background
    const css = readFileInContainer('site/style.css')
    expect(css.toLowerCase()).toMatch(/blue|#0000ff|rgb\(0/)

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)
})

// ---------------------------------------------------------------------------
// Phase 3: Build & Test
// ---------------------------------------------------------------------------

describe('Phase 3: Build & Test', () => {
  it('SC-6: npm project — init, write code, run tests', async () => {
    cleanupPaths.push('string-utils')

    const { response } = await sendAndWait(
      "Do these steps using the tools: 1) Use file_write to create string-utils/package.json with content '{\"name\":\"string-utils\",\"version\":\"1.0.0\"}'. 2) Use file_write to create string-utils/src/index.js that exports a function 'capitalize' which uppercases the first letter of a string (module.exports = { capitalize }). 3) Use file_write to create string-utils/test/test.js that requires('../src/index.js') and tests capitalize with 3 cases using console.assert ('hello' → 'Hello', 'world' → 'World', '' → ''). Print 'All tests passed' at the end if no assertions fail. 4) Use shell_exec with command 'node' and args ['string-utils/test/test.js'] to run the tests. Tell me if they pass.",
      600_000
    )

    // Verify project structure
    expectWorkspaceEntry('string-utils/package.json', response)
    expectWorkspaceEntry('string-utils/src/index.js', response)
    expectWorkspaceEntry('string-utils/test/test.js', response)

    const output = kubectlExec('node /workspace/string-utils/test/test.js 2>&1')
    expect(output).toContain('All tests passed')
    expect(output.toLowerCase()).not.toContain('assertionerror')

    if (response) {
      expect(response).toContain('All tests passed')
      expect(response.toLowerCase()).not.toContain('assertionerror')
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)
})

// ---------------------------------------------------------------------------
// Phase 4: Error Recovery
// ---------------------------------------------------------------------------

describe('Phase 4: Error Recovery', () => {
  it('SC-8: syntax error — detect and fix autonomously', async () => {
    cleanupPaths.push('broken.js')

    const { response } = await sendAndWait(
      'Create a file called broken.js with this exact content: \'function greet(name { return "Hello " + name; } console.log(greet("World"));\'. Run it with node. If there\'s an error, fix the file and run it again. Tell me the final output.',
      600_000
    )

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toContain('hello world')
    }

    const output = kubectlExec('cd /workspace && node broken.js 2>&1')
    expect(output).toContain('Hello World')

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)

  it('SC-9: fetch API — handle errors and adapt', async () => {
    cleanupPaths.push('fetch-test.js')

    const { response } = await sendAndWait(
      "Use file_write to create a Node.js script called fetch-test.js that uses the built-in fetch API to GET https://httpbin.org/get and prints the response status code. Then use shell_exec to run 'node fetch-test.js' and tell me the result. If there are any errors, fix the file with file_write and run it again.",
      600_000
    )

    if (response) {
      expect(response).toMatch(/\b200\b/)
    }

    expectWorkspaceEntry('fetch-test.js', response)

    const output = runNodeFile('fetch-test.js')
    expect(output).toMatch(/\b200\b/)

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)
})

// ---------------------------------------------------------------------------
// Phase 5: Complex Projects
// ---------------------------------------------------------------------------

describe('Phase 5: Complex Projects', () => {
  it('SC-10: CLI word counter — multi-file with argument parsing', async () => {
    cleanupPaths.push('wordcount', 'sample.txt')

    const { response } = await sendAndWait(
      "Use the tools to build this: 1) Use file_write to create wordcount/index.js — a Node.js script that reads a filename from process.argv[2], reads the file with fs.readFileSync, counts lines, words, and characters, and prints 'Lines: N, Words: N, Characters: N'. 2) Use file_write to create sample.txt with at least 3 lines of text. 3) Use shell_exec to run 'node wordcount/index.js sample.txt' and tell me the counts.",
      600_000
    )

    expectWorkspaceEntry('wordcount/index.js', response)
    expectWorkspaceEntry('sample.txt', response)

    const sample = readFileInContainer('sample.txt')
    const expected = countTextStats(sample)
    const output = kubectlExec('cd /workspace && node wordcount/index.js sample.txt 2>&1')
    const lowerOutput = output.toLowerCase()
    expect(lowerOutput).toMatch(new RegExp(`lines?[:\\s]+${expected.lines}\\b`))
    expect(lowerOutput).toMatch(new RegExp(`words?[:\\s]+${expected.words}\\b`))
    expect(lowerOutput).toMatch(new RegExp(`characters?[:\\s]+${expected.characters}\\b`))

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toMatch(new RegExp(`lines?[:\\s]+${expected.lines}\\b`))
      expect(lower).toMatch(new RegExp(`words?[:\\s]+${expected.words}\\b`))
      expect(lower).toMatch(new RegExp(`characters?[:\\s]+${expected.characters}\\b`))
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)

  it('SC-11: JSON pipeline — write data, process, verify output', async () => {
    cleanupPaths.push('users.json', 'filter.js', 'active-users.json')

    const { response } = await sendAndWait(
      'Create a data processing pipeline: 1) Write a JSON file called users.json with: {"users":[{"name":"Alice","age":30,"active":true},{"name":"Bob","age":25,"active":false},{"name":"Charlie","age":35,"active":true}]}. 2) Create a Node.js script called filter.js that reads users.json, filters only active users, and writes the result to active-users.json. 3) Run filter.js. 4) Read active-users.json and tell me how many active users there are and their names.',
      600_000
    )

    // Verify files were created
    expectWorkspaceEntry('users.json', response)
    expectWorkspaceEntry('filter.js', response)
    expectWorkspaceEntry('active-users.json', response)

    // Verify active-users.json content directly
    const activeUsersRaw = readFileInContainer('active-users.json')
    const parsed = JSON.parse(activeUsersRaw)
    // Structure may vary: array or {users: [...]} or {activeUsers: [...]}
    const users = Array.isArray(parsed) ? parsed : parsed.users || parsed.activeUsers || []
    expect(users.length).toBe(2)

    const names = users.map((u: any) => u.name?.toLowerCase())
    expect(names).toContain('alice')
    expect(names).toContain('charlie')
    expect(names).not.toContain('bob')

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toContain('alice')
      expect(lower).toContain('charlie')
      expect(lower).not.toContain('bob')
      expect(lower).toMatch(/\b2\b|two/)
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (!RUN_SOFTWARE_CREATION) return

  if (cleanupPaths.length > 0) {
    const pathList = cleanupPaths.map(p => `/workspace/${p}`).join(' ')
    try {
      kubectlExec(`rm -rf ${pathList}`)
      console.log(`[Cleanup] Removed: ${pathList}`)
    } catch (e) {
      console.log(`[Cleanup] Warning: could not remove paths: ${e}`)
    }
  }
})
