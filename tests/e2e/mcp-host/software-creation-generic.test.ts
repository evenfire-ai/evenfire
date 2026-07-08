/**
 * E2E: Software Creation (Generic Prompts) — validate the Clerum agent can
 * create, build, and test software using natural-language prompts WITHOUT
 * explicit tool naming. Targets Claude Opus 4.6.
 *
 * Tests SCG-1 through SCG-10 — all prompts are natural language only.
 * The LLM must autonomously decide which tools to call.
 *
 * Requires a REAL Claude API key — these tests make actual LLM calls.
 *
 * Prerequisites:
 *   1. Minikube running with mcp-host deployed (image with /workspace dir)
 *   2. Real CLAUDE_API_KEY in chatllm-api-keys secret
 *   3. ConfigMap tuned for software creation with Claude Opus 4.6:
 *        CLERUM_MODEL_PROVIDER=claude
 *        CLERUM_MODEL_NAME=claude-opus-4-6
 *        CLERUM_ENABLE_APPROVAL=false
 *        CLERUM_AGENT_MAX_TOOL_CALLS=200
 *        CLERUM_AGENT_MAX_TASK_DURATION=1200000
 *        CLERUM_SHELL_TIMEOUT=120000
 *   4. Port-forwarding active:
 *        kubectl port-forward -n mcp-host svc/chatllm 8080:8080
 *
 * Run:
 *   cd tests/e2e && npx vitest run software-creation-generic.test.ts
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

/** Auto-incrementing counter — starts at 100 to avoid collision with SC suite. */
let testCounter = 100

/**
 * Send a message and wait for the agent to finish, handling the hardcoded
 * 5-minute HTTP timeout in the /message endpoint.
 *
 * Each call uses a unique userId (scg-test-*) to isolate conversations.
 */
async function sendAndWait(
  content: string,
  timeoutMs: number = 300_000
): Promise<{ response: string | null; timedOut: boolean }> {
  testCounter++
  const userId = `scg-test-${testCounter}`

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function runNodeFile(path: string, args: string[] = []): string {
  const renderedArgs = args.map(arg => shellQuote(arg)).join(' ')
  return kubectlExec(
    `cd /workspace && node ${shellQuote(path)}${renderedArgs ? ` ${renderedArgs}` : ''} 2>&1`
  )
}

function firstExistingPath(paths: string[]): string | null {
  for (const path of paths) {
    if (fileExists(path)) return path
  }
  return null
}

function runNodeCandidate(paths: string[]): string {
  const path = firstExistingPath(paths)
  expect(path).toBeTruthy()
  return kubectlExec(`cd /workspace && node ${path} 2>&1`)
}

function expectWorkspaceEntry(path: string, response: string | null): void {
  expect(
    fileExists(path),
    [
      `Expected agent to create /workspace/${path}, but it was missing.`,
      'This suite validates concrete filesystem artifacts, not only open-ended model responses.',
      `Agent response: ${response ?? '<empty>'}`,
    ].join('\n\n')
  ).toBe(true)
}

function normalizeLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

beforeAll(async () => {
  if (!RUN_SOFTWARE_CREATION) return

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

function parseJsonFromOutput<T>(output: string): T {
  const trimmed = output.trim()
  const candidates = [trimmed]

  const arrayStart = trimmed.indexOf('[')
  const arrayEnd = trimmed.lastIndexOf(']')
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1))
  }

  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  if (objectStart !== -1 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1))
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      continue
    }
  }

  throw new Error(`Could not parse JSON from output: ${trimmed}`)
}

// ---------------------------------------------------------------------------
// Phase 1: Single File Creation
// ---------------------------------------------------------------------------

describe('Phase 1: Single File Creation', () => {
  it('SCG-1: Fibonacci sequence generator', async () => {
    cleanupPaths.push('fibonacci.js', 'fib.js')

    const { response } = await sendAndWait(
      'Create a JavaScript program that computes the first 15 Fibonacci numbers and prints them as a comma-separated list. Save it and run it, then tell me the output.',
      300_000
    )

    if (response) {
      // First 15 Fibonacci: 0,1,1,2,3,5,8,13,21,34,55,89,144,233,377
      expect(response).toContain('233')
      expect(response).toContain('377')
    }

    const output = runNodeCandidate(['fibonacci.js', 'fib.js'])
    const numbers = output.match(/-?\d+/g)?.map(Number) ?? []
    expect(numbers).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377])

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)

  it('SCG-2: Temperature converter', async () => {
    cleanupPaths.push('temperature.js', 'temp.js', 'convert.js', 'converter.js', 'celsius.js')

    const { response } = await sendAndWait(
      "Build a Node.js script that converts these Celsius temperatures to Fahrenheit: 0, 25, 100, -40. Print each conversion on its own line in the format 'XC = YF'. Run the program and show me the results.",
      300_000
    )

    if (response) {
      expect(response).toContain('32') // 0C = 32F
      expect(response).toContain('77') // 25C = 77F
      expect(response).toContain('212') // 100C = 212F
      expect(response).toContain('-40') // -40C = -40F
    }

    const output = runNodeCandidate([
      'temperature.js',
      'temp.js',
      'convert.js',
      'converter.js',
      'celsius.js',
    ])
    const lower = output.toLowerCase()
    expect(lower).toMatch(/0.*32/)
    expect(lower).toMatch(/25.*77/)
    expect(lower).toMatch(/100.*212/)
    expect(lower).toMatch(/-40.*-40/)

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)

  it('SCG-3: Prime number sieve', async () => {
    cleanupPaths.push('primes.js', 'sieve.js', 'prime.js')

    const { response } = await sendAndWait(
      'Write a program that finds all prime numbers between 1 and 50 using the Sieve of Eratosthenes algorithm. Save it, execute it, and tell me the list of primes.',
      300_000
    )

    if (response) {
      // Primes up to 50: 2,3,5,7,11,13,17,19,23,29,31,37,41,43,47
      expect(response).toContain('47')
      expect(response).toContain('43')
      expect(response).toContain('2')
    }

    const output = runNodeCandidate(['primes.js', 'sieve.js', 'prime.js'])
    const numbers = output.match(/-?\d+/g)?.map(Number) ?? []
    expect(numbers).toEqual([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47])

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)
})

// ---------------------------------------------------------------------------
// Phase 2: Multi-File Projects
// ---------------------------------------------------------------------------

describe('Phase 2: Multi-File Projects', () => {
  it('SCG-4: Sorting library with multiple algorithms', async () => {
    cleanupPaths.push('sorter')

    const { response } = await sendAndWait(
      "Create a small project in a folder called 'sorter' with exactly two files: sorter/sorts.js should export bubbleSort and insertionSort for arrays of numbers, and sorter/run.js should import both, sort the array [64, 34, 25, 12, 22, 11, 90] with each algorithm, and print both sorted results. Run sorter/run.js and tell me the output.",
      300_000
    )

    expectWorkspaceEntry('sorter', response)
    expectWorkspaceEntry('sorter/sorts.js', response)
    expectWorkspaceEntry('sorter/run.js', response)

    const sorted = [11, 12, 22, 25, 34, 64, 90]
    const outputLines = normalizeLines(runNodeFile('sorter/run.js'))
    const arrays = outputLines
      .map(line => line.match(/-?\d+/g)?.map(Number) ?? [])
      .filter(numbers => numbers.length === sorted.length)
    expect(arrays).toEqual([sorted, sorted])

    if (response) {
      const normalizedResponse = response.replace(/\s+/g, '')
      expect(normalizedResponse).toContain('11,12,22,25,34,64,90')
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 360_000)

  it('SCG-5: Task manager data model', async () => {
    cleanupPaths.push('taskman')

    const { response } = await sendAndWait(
      "Build a Node.js project in a 'taskman' folder. Create taskman/tasks.js that exports addTask(title, priority), listTasks(), and completeTask(id). Tasks should be stored in an in-memory array with id, title, priority, and completed fields. Then create taskman/run.js that adds 3 tasks ('Buy groceries' priority 2, 'Write report' priority 1, 'Call dentist' priority 3), completes the second one, lists all tasks, and prints the result as JSON. Run taskman/run.js and show me the output.",
      600_000
    )

    expectWorkspaceEntry('taskman', response)
    expectWorkspaceEntry('taskman/tasks.js', response)
    expectWorkspaceEntry('taskman/run.js', response)

    const output = runNodeFile('taskman/run.js')
    const tasks =
      parseJsonFromOutput<Array<{ title: string; priority: number; completed: boolean }>>(output)
    expect(tasks).toHaveLength(3)

    const byTitle = new Map(tasks.map(task => [task.title, task]))
    expect(byTitle.get('Buy groceries')).toMatchObject({
      priority: 2,
      completed: false,
    })
    expect(byTitle.get('Write report')).toMatchObject({
      priority: 1,
      completed: true,
    })
    expect(byTitle.get('Call dentist')).toMatchObject({
      priority: 3,
      completed: false,
    })

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toContain('buy groceries')
      expect(lower).toContain('write report')
      expect(lower).toContain('call dentist')
      expect(lower).toMatch(/write report.*true|\"completed\":\s*true/)
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)
})

// ---------------------------------------------------------------------------
// Phase 3: Build & Test
// ---------------------------------------------------------------------------

describe('Phase 3: Build & Test', () => {
  it('SCG-6: Array utilities with assertion tests', async () => {
    cleanupPaths.push('array-utils')

    const { response } = await sendAndWait(
      "Create a project in a folder called 'array-utils' with array-utils/index.js exporting these functions: unique(arr) removes duplicates, flatten(arr) flattens nested arrays one level, and chunk(arr, size) splits an array into chunks of the given size. Also create array-utils/test.js that tests each function with at least 2 test cases using console.assert and prints 'All 6 tests passed' at the end if nothing fails. Run array-utils/test.js and tell me the result.",
      600_000
    )

    expectWorkspaceEntry('array-utils', response)
    expectWorkspaceEntry('array-utils/index.js', response)
    expectWorkspaceEntry('array-utils/test.js', response)

    const output = runNodeFile('array-utils/test.js')
    expect(output).toContain('All 6 tests passed')
    expect(output.toLowerCase()).not.toContain('assertionerror')

    if (response) {
      expect(response).toContain('All 6 tests passed')
      expect(response.toLowerCase()).not.toContain('assertionerror')
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)

  it('SCG-7: CSV parser and revenue aggregator', async () => {
    cleanupPaths.push(
      'sales.csv',
      'parse-sales.js',
      'csv-parser.js',
      'sales-report.js',
      'aggregate.js',
      'sales.js',
      'parse-csv.js',
      'revenue.js'
    )

    const { response } = await sendAndWait(
      `Create a CSV data file called sales.csv with this content:
product,quantity,price
Widget,10,4.99
Gadget,5,14.99
Widget,3,4.99
Doohickey,7,9.99
Gadget,2,14.99

Then write a Node.js script called sales-report.js that reads sales.csv, parses it, and for each product computes the total quantity sold and total revenue (quantity times price). Print a summary showing each product, total units, and total revenue sorted by revenue descending. Run sales-report.js and show me the results.`,
      600_000
    )

    expectWorkspaceEntry('sales.csv', response)
    expectWorkspaceEntry('sales-report.js', response)

    const output = runNodeFile('sales-report.js')
    const lowerOutput = output.toLowerCase()
    expect(lowerOutput).toMatch(/gadget.*7.*104\.93/)
    expect(lowerOutput).toMatch(/doohickey.*7.*69\.93/)
    expect(lowerOutput).toMatch(/widget.*13.*64\.87/)
    expect(lowerOutput.indexOf('gadget')).toBeLessThan(lowerOutput.indexOf('doohickey'))
    expect(lowerOutput.indexOf('doohickey')).toBeLessThan(lowerOutput.indexOf('widget'))

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toMatch(/gadget.*7.*104\.93/)
      expect(lower).toMatch(/doohickey.*7.*69\.93/)
      expect(lower).toMatch(/widget.*13.*64\.87/)
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)
})

// ---------------------------------------------------------------------------
// Phase 4: Error Recovery
// ---------------------------------------------------------------------------

describe('Phase 4: Error Recovery', () => {
  it('SCG-8: Logic bug detection and fix (palindrome)', async () => {
    cleanupPaths.push('palindrome.js', 'isPalindrome.js')

    const { response } = await sendAndWait(
      "Create a Node.js script that implements a function called isPalindrome(str) which checks if a string is a palindrome (reads the same forwards and backwards, case-insensitive). I want you to intentionally write it with a bug first: make it compare the string to its reverse but forget to lowercase both sides, so 'Racecar' returns false instead of true. Save and run it testing with 'racecar', 'Racecar', 'hello', and 'Madam'. When you see the bug with 'Racecar' or 'Madam', fix it and run again. Report the final correct output for all four test strings.",
      600_000
    )

    const output = runNodeCandidate(['palindrome.js', 'isPalindrome.js'])
    const lowerOutput = output.toLowerCase()
    expect(lowerOutput).toMatch(/racecar.*true/)
    expect(lowerOutput).toMatch(/hello.*false/)
    expect(lowerOutput).toMatch(/madam.*true/)

    if (response) {
      const lower = response.toLowerCase()
      expect(lower).toMatch(/racecar.*true/)
      expect(lower).toMatch(/hello.*false/)
      expect(lower).toMatch(/madam.*true/)
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)
})

// ---------------------------------------------------------------------------
// Phase 5: Complex Projects
// ---------------------------------------------------------------------------

describe('Phase 5: Complex Projects', () => {
  it('SCG-9: Inventory data transformation pipeline', async () => {
    cleanupPaths.push(
      'inventory.json',
      'report.json',
      'process-inventory.js',
      'pipeline.js',
      'transform.js',
      'process.js',
      'inventory-processor.js'
    )

    const { response } = await sendAndWait(
      "Build a data processing pipeline with these steps: 1) Create a JSON file called inventory.json with an array of 5 products, each having name, category (either 'electronics' or 'clothing'), price, and inStock (boolean). Make sure at least 2 products are out of stock. 2) Create a processing script that reads inventory.json, filters only in-stock items, groups them by category, calculates the average price per category, and writes the result to a file called report.json. 3) Run the script. 4) Show me the contents of report.json.",
      600_000
    )

    expectWorkspaceEntry('inventory.json', response)
    expectWorkspaceEntry('report.json', response)

    // Verify inventory has at least 2 out-of-stock items
    const inventoryRaw = readFileInContainer('inventory.json')
    const inventory = JSON.parse(inventoryRaw)
    const items: Array<{ category: string; price: number; inStock: boolean }> = Array.isArray(
      inventory
    )
      ? inventory
      : inventory.products || inventory.items || inventory.inventory || []
    const outOfStock = items.filter((i: any) => !i.inStock)
    expect(outOfStock.length).toBeGreaterThanOrEqual(2)

    // Verify report.json is valid JSON with category data
    const reportRaw = readFileInContainer('report.json')
    const report = JSON.parse(reportRaw)
    expect(report).toBeTruthy()

    const grouped = items
      .filter((item: any) => item.inStock)
      .reduce((acc: Record<string, number[]>, item: any) => {
        const key = String(item.category)
        acc[key] ??= []
        acc[key].push(Number(item.price))
        return acc
      }, {})
    const expectedAverages: Record<string, number> = Object.fromEntries(
      Object.entries(grouped).map(([category, prices]) => [
        category,
        prices.reduce((sum, price) => sum + price, 0) / prices.length,
      ])
    )
    const reportString = JSON.stringify(report).toLowerCase()
    for (const category of Object.keys(expectedAverages)) {
      expect(reportString).toContain(category.toLowerCase())
      expect(reportString).toContain(expectedAverages[category].toFixed(2))
    }

    const status = await getRpcHostStatus(authToken)
    expect(status.agent.state).toBe('idle')
  }, 660_000)

  it('SCG-10: CLI calculator with error handling', async () => {
    cleanupPaths.push('calc-cli')

    const { response } = await sendAndWait(
      "Build a command-line calculator in a folder called 'calc-cli'. Create calc-cli/index.js as a Node.js script that takes 3 arguments: number1, operator (+, -, *, /), and number2. It should print the result. Handle division by zero gracefully by printing an error message instead of crashing. Create the calculator, then test it with these four operations: '10 + 5', '100 - 37', '6 * 7', '99 / 0'. Tell me all four results.",
      600_000
    )

    expectWorkspaceEntry('calc-cli', response)
    expectWorkspaceEntry('calc-cli/index.js', response)

    expect(runNodeFile('calc-cli/index.js', ['10', '+', '5']).trim()).toBe('15')
    expect(runNodeFile('calc-cli/index.js', ['100', '-', '37']).trim()).toBe('63')
    expect(runNodeFile('calc-cli/index.js', ['6', '*', '7']).trim()).toBe('42')
    const zeroDivision = runNodeFile('calc-cli/index.js', ['99', '/', '0']).toLowerCase()
    expect(zeroDivision).toMatch(/zero|error|cannot|divide/)
    expect(zeroDivision).not.toContain('infinity')

    if (response) {
      expect(response).toContain('15') // 10+5
      expect(response).toContain('63') // 100-37
      expect(response).toContain('42') // 6*7
      const lower = response.toLowerCase()
      expect(lower).toMatch(/zero|error|cannot|divide/)
      expect(lower).not.toContain('infinity')
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
