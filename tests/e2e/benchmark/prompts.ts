/**
 * Benchmark prompt definitions — 5 categories × 3 difficulty levels.
 *
 * Each prompt includes a validator function that returns a 0-100 score
 * based on deterministic checks (regex, keyword matching, format validation).
 */

export type Difficulty = 'easy' | 'medium' | 'hard'
export type Category =
  | 'reasoning'
  | 'tool_single'
  | 'tool_chain'
  | 'mcp_tool'
  | 'instruction_following'

export interface BenchmarkPrompt {
  id: string
  category: Category
  difficulty: Difficulty
  prompt: string
  /** Short description for test names */
  label: string
  /** Deterministic validator — returns score 0-100 */
  validate: (response: string) => number
}

// ---------------------------------------------------------------------------
// Category 1: Reasoning (pure text, no tools)
// ---------------------------------------------------------------------------

const reasoning: BenchmarkPrompt[] = [
  {
    id: 'R-EASY',
    category: 'reasoning',
    difficulty: 'easy',
    prompt: 'What is 17 * 23? Show your work and give the final answer.',
    label: 'simple multiplication',
    validate: r => (r.includes('391') ? 100 : 0),
  },
  {
    id: 'R-MED',
    category: 'reasoning',
    difficulty: 'medium',
    prompt:
      'A farmer has 3 fields. Field A is twice the size of Field B. Field C is 10 acres more than Field B. The total area is 70 acres. What is the size of each field in acres? Give exact numbers.',
    label: 'word problem algebra',
    validate: r => {
      // B=15, A=30, C=25
      const hasB = /15/.test(r)
      const hasA = /30/.test(r)
      const hasC = /25/.test(r)
      if (hasA && hasB && hasC) return 100
      if ((hasA && hasB) || (hasA && hasC) || (hasB && hasC)) return 60
      if (hasA || hasB || hasC) return 30
      return 0
    },
  },
  {
    id: 'R-HARD',
    category: 'reasoning',
    difficulty: 'hard',
    prompt:
      'You have 8 identical-looking balls. One is slightly heavier than the rest. You have a two-pan balance scale. What is the minimum number of weighings needed to guarantee finding the heavier ball? Describe the strategy step by step.',
    label: 'balance scale puzzle',
    validate: r => {
      const lower = r.toLowerCase()
      // Answer is 2 weighings
      const hasAnswer = /\b2\b/.test(r) && /weigh/i.test(r)
      // Should mention dividing into groups of 3
      const hasStrategy = /group/i.test(r) || /divid/i.test(r) || /split/i.test(r)
      const hasThrees = /\b3\b/.test(r)
      let score = 0
      if (hasAnswer) score += 50
      if (hasStrategy) score += 25
      if (hasThrees) score += 25
      return score
    },
  },
]

// ---------------------------------------------------------------------------
// Category 2: Tool Use — Single Tool (native tools)
// ---------------------------------------------------------------------------

const toolSingle: BenchmarkPrompt[] = [
  {
    id: 'TS-EASY',
    category: 'tool_single',
    difficulty: 'easy',
    prompt: 'Use the system_info tool to tell me the current hostname of this system.',
    label: 'system_info hostname',
    validate: r => {
      // Should contain some hostname string (not empty)
      const lower = r.toLowerCase()
      if (lower.includes('hostname') || lower.includes('host')) return 100
      // If it returned any system info, partial credit
      if (r.length > 20) return 50
      return 0
    },
  },
  {
    id: 'TS-MED',
    category: 'tool_single',
    difficulty: 'medium',
    prompt:
      "Write a file at /workspace/benchmark/hello.txt with the exact content 'Hello Benchmark' (no quotes). Then read the file back and confirm its content.",
    label: 'file write + read',
    validate: r => {
      const lower = r.toLowerCase()
      const hasWrite = /writ|creat/i.test(r)
      const hasRead = /read|content|hello benchmark/i.test(r)
      const hasConfirm = /confirm|verified|matches|correct|success/i.test(r)
      let score = 0
      if (hasWrite) score += 30
      if (hasRead) score += 40
      if (hasConfirm) score += 30
      return score
    },
  },
  {
    id: 'TS-HARD',
    category: 'tool_single',
    difficulty: 'hard',
    prompt:
      "Use shell_exec to create a directory /workspace/benchmark/project. Then use file_write to create /workspace/benchmark/project/package.json with a valid JSON object containing name 'bench-test' and version '1.0.0'. Finally use file_read to read it back and use json_transform to extract the version field. Report the extracted version.",
    label: 'multi-tool orchestration',
    validate: r => {
      let score = 0
      if (/bench-test/i.test(r)) score += 25
      if (/1\.0\.0/.test(r)) score += 50
      if (/version/i.test(r)) score += 25
      return score
    },
  },
]

// ---------------------------------------------------------------------------
// Category 3: Tool Use — Multi-step Chain (native tools)
// ---------------------------------------------------------------------------

const toolChain: BenchmarkPrompt[] = [
  {
    id: 'TC-EASY',
    category: 'tool_chain',
    difficulty: 'easy',
    prompt:
      'Write the number 42 to a file at /workspace/benchmark/num.txt, read it back, and confirm the content matches what you wrote.',
    label: 'write-read-confirm',
    validate: r => {
      const has42 = /42/.test(r)
      const hasConfirm = /confirm|match|correct|verified|success/i.test(r)
      return has42 && hasConfirm ? 100 : has42 ? 60 : 0
    },
  },
  {
    id: 'TC-MED',
    category: 'tool_chain',
    difficulty: 'medium',
    prompt:
      'Create a bash script at /workspace/benchmark/fib.sh that prints the first 10 Fibonacci numbers (one per line, starting from 0). Make it executable and run it with shell_exec. Report the output.',
    label: 'fibonacci script',
    validate: r => {
      // First 10 Fibonacci: 0 1 1 2 3 5 8 13 21 34
      const fibs = ['0', '1', '1', '2', '3', '5', '8', '13', '21', '34']
      let found = 0
      for (const f of fibs) {
        if (r.includes(f)) found++
      }
      // Need at least the later unique ones to confirm correctness
      const hasKey = /13/.test(r) && /21/.test(r) && /34/.test(r)
      if (hasKey && found >= 8) return 100
      if (hasKey) return 70
      if (found >= 5) return 50
      return found >= 3 ? 30 : 0
    },
  },
  {
    id: 'TC-HARD',
    category: 'tool_chain',
    difficulty: 'hard',
    prompt:
      "Create a Node.js project at /workspace/benchmark/calc/: 1) Write package.json with name 'calc' and version '1.0.0'. 2) Write index.js that exports functions add(a,b) and multiply(a,b). 3) Write test.js that requires index.js and tests: add(2,3)===5, multiply(4,5)===20 — printing PASS or FAIL for each. 4) Run 'node test.js' with shell_exec and report the results.",
    label: 'node project create+test',
    validate: r => {
      const lower = r.toLowerCase()
      let score = 0
      if (/pass/i.test(r)) score += 50
      if (/add.*5|5.*add/i.test(r) || /2.*3.*5/.test(r)) score += 15
      if (/multiply.*20|20.*multiply/i.test(r) || /4.*5.*20/.test(r)) score += 15
      if (/node\s+test/i.test(r) || /ran|execut/i.test(r)) score += 20
      return Math.min(score, 100)
    },
  },
]

// ---------------------------------------------------------------------------
// Category 4: MCP Tool Use (requires mock-mcp-server with echo/add)
// ---------------------------------------------------------------------------

const mcpTool: BenchmarkPrompt[] = [
  {
    id: 'MCP-EASY',
    category: 'mcp_tool',
    difficulty: 'easy',
    prompt: "Use the echo tool to echo the text 'benchmark test'. Return the echoed result.",
    label: 'echo tool',
    validate: r => (/benchmark test/i.test(r) ? 100 : 0),
  },
  {
    id: 'MCP-MED',
    category: 'mcp_tool',
    difficulty: 'medium',
    prompt:
      'Use the add tool to compute 123 + 456. Then use the echo tool to echo the result. What is the final answer?',
    label: 'add then echo',
    validate: r => {
      const has579 = /579/.test(r)
      return has579 ? 100 : 0
    },
  },
  {
    id: 'MCP-HARD',
    category: 'mcp_tool',
    difficulty: 'hard',
    prompt:
      "Use the add tool to compute these three sums: (10+20), (30+40), (50+60). Then use the echo tool to echo all three results as a comma-separated string like '30,70,110'. Report the final echoed string.",
    label: 'multi-add then echo',
    validate: r => {
      const has30 = /\b30\b/.test(r)
      const has70 = /\b70\b/.test(r)
      const has110 = /\b110\b/.test(r)
      let score = 0
      if (has30) score += 33
      if (has70) score += 33
      if (has110) score += 34
      return score
    },
  },
]

// ---------------------------------------------------------------------------
// Category 5: Instruction Following (precision/format)
// ---------------------------------------------------------------------------

const instructionFollowing: BenchmarkPrompt[] = [
  {
    id: 'IF-EASY',
    category: 'instruction_following',
    difficulty: 'easy',
    prompt:
      'List exactly 5 programming languages, one per line, numbered 1 through 5. Do not include any other text.',
    label: 'numbered list',
    validate: r => {
      const lines = r
        .trim()
        .split('\n')
        .filter(l => l.trim().length > 0)
      // Check for numbered lines
      let numberedCount = 0
      for (let i = 1; i <= 5; i++) {
        if (lines.some(l => l.trim().startsWith(`${i}`))) numberedCount++
      }
      if (numberedCount === 5 && lines.length <= 7) return 100
      if (numberedCount >= 3) return 60
      return 0
    },
  },
  {
    id: 'IF-MED',
    category: 'instruction_following',
    difficulty: 'medium',
    prompt:
      'Generate a JSON object with exactly these keys: "name" (a string), "age" (a number), "hobbies" (an array of exactly 3 strings). Output ONLY the raw JSON. No explanation, no code blocks, no markdown.',
    label: 'strict JSON output',
    validate: r => {
      let score = 0
      // Try to extract JSON from the response
      const jsonMatch = r.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return 0
      try {
        const obj = JSON.parse(jsonMatch[0])
        if (typeof obj.name === 'string') score += 25
        if (typeof obj.age === 'number') score += 25
        if (
          Array.isArray(obj.hobbies) &&
          obj.hobbies.length === 3 &&
          obj.hobbies.every((h: unknown) => typeof h === 'string')
        )
          score += 25
        // Bonus: was it clean JSON without extra text?
        const trimmed = r.trim()
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) score += 25
      } catch {
        return 10 // Had something JSON-like but invalid
      }
      return score
    },
  },
  {
    id: 'IF-HARD',
    category: 'instruction_following',
    difficulty: 'hard',
    prompt:
      'Write a CSV with headers: id,name,score. Add exactly 5 data rows. Each score must be an integer between 70 and 100 inclusive. Output ONLY the raw CSV content. No code blocks, no explanation, no markdown formatting.',
    label: 'strict CSV output',
    validate: r => {
      let score = 0
      // Strip potential code block markers
      const clean = r
        .replace(/```[\s\S]*?```/g, '')
        .replace(/```/g, '')
        .trim()
      const lines = clean.split('\n').filter(l => l.trim().length > 0)

      // Check header
      if (lines.length > 0 && /^id,name,score$/i.test(lines[0].trim())) {
        score += 20
      }

      // Check data rows
      let validRows = 0
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',')
        if (parts.length === 3) {
          const s = parseInt(parts[2].trim(), 10)
          if (!isNaN(s) && s >= 70 && s <= 100) validRows++
        }
      }

      if (validRows === 5) score += 50
      else if (validRows >= 3) score += 30
      else if (validRows >= 1) score += 10

      // Exact row count (header + 5 data = 6 lines)
      if (lines.length === 6) score += 15

      // Clean output (no extra text)
      const trimmed = r.trim()
      if (!trimmed.includes('```') && !trimmed.includes('Here')) score += 15

      return Math.min(score, 100)
    },
  },
]

// ---------------------------------------------------------------------------
// Export all prompts
// ---------------------------------------------------------------------------

export const ALL_PROMPTS: BenchmarkPrompt[] = [
  ...reasoning,
  ...toolSingle,
  ...toolChain,
  ...mcpTool,
  ...instructionFollowing,
]

export const CATEGORIES: Category[] = [
  'reasoning',
  'tool_single',
  'tool_chain',
  'mcp_tool',
  'instruction_following',
]

export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard']

/** Get prompts filtered by category and/or difficulty. */
export function getPrompts(opts?: {
  category?: Category
  difficulty?: Difficulty
}): BenchmarkPrompt[] {
  return ALL_PROMPTS.filter(
    p =>
      (!opts?.category || p.category === opts.category) &&
      (!opts?.difficulty || p.difficulty === opts.difficulty)
  )
}
