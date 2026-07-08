// @ts-check
/**
 * ESLint flat config for mcp-host.
 *
 * Enforces v2 task-cancel architecture invariants (spec §9.6 Phase E, §11):
 *   Rule 1 — No task.status = ... outside TaskLifecycle (Invariant I1)
 *   Rule 2 — No new MessageQueue() outside main.ts + tests (spec §4.2)
 *
 * Rule 3 (legacy SSE event type literals 'cancelled'/'error'/'done') is DEFERRED to tsc:
 *   The ProgressEvent union type no longer includes those discriminants, so the TypeScript
 *   compiler already rejects them. The AST selector { type: 'cancelled' } is too broad —
 *   it also fires on LoopResult ('cancelled') and LlmPortResult ('error'), which are
 *   legitimate non-SSE uses. Narrowing requires TypeScript type info at the ESLint layer.
 *
 * Rule 4 ([CANCEL] console.log ban) is enforced via code review:
 *   All [CANCEL] debug logs were removed in Phase E. Future additions must use structured
 *   JSON console.log per spec §10. The AST selector cannot match regex inside string literals.
 */
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        // Rule 1a: No task.status = ... (Invariant I1 — TaskLifecycle is single writer).
        // Matches: <expr>.task.status = ... (e.g. this.task.status = X)
        {
          selector:
            "AssignmentExpression[operator='='][left.type='MemberExpression'][left.property.name='status'][left.object.type='MemberExpression'][left.object.property.name='task']",
          message:
            'task.status must only be written by TaskLifecycle. Use lifecycle.transition(...) instead (Invariant I1, spec §4.1).',
        },
        // Rule 1b: No task.status = ... where task is a direct Identifier (PR-186 M4).
        // Catches parameter form: task.status = X (complements Rule 1a).
        {
          selector:
            "AssignmentExpression[operator='='][left.type='MemberExpression'][left.property.name='status'][left.object.type='Identifier'][left.object.name='task']",
          message:
            'task.status must only be written by TaskLifecycle. Use lifecycle.transition(...) instead (Invariant I1, spec §4.1).',
        },
        // Rule 2: No new MessageQueue() — factory shim, construct only in main.ts wiring.
        // Exempted for main.ts and test files via the overrides block below.
        {
          selector: "NewExpression[callee.name='MessageQueue']",
          message:
            'MessageQueue is a factory shim — construct only in main.ts wiring. See spec §4.2.',
        },
      ],
    },
  },
  // Exemptions: main.ts and test files may construct MessageQueue.
  {
    files: ['src/main.ts', 'src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
]
