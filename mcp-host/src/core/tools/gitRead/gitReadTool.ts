import { logger } from '../../../logger'
import type { ExecutionContext, FileReads, Tool } from '../../interfaces'
import type { ToolOutput, ValidationResult } from '../../types'
import { buildGitReadArgv } from './argv'
import {
  GIT_READ_DEFINITION,
  GIT_READ_TOOL_NAME,
  type GitReadParams,
  checkGitReadParams,
  gitReadFileReads,
  validateGitReadParams,
} from './definition'
import { type GitReadRefusalCategory, runPreflight } from './preflight'
import { type GitSpawn, type GitSpawnResult, spawnGit } from './runner'

/** The ShellTool result budget (`MAX_TOTAL_BYTES - 2048`), kept as its own constant. */
export const GIT_READ_MAX_RESULT_BYTES = 1024 * 1024 - 2048
const GIT_MAX_BUFFER = 1024 * 1024
const SUBMODULE_INDEX_MAX_BUFFER = 8 * 1024 * 1024
export const GIT_READ_TRUNCATED_LINE = '[output truncated]'
export const GIT_READ_SUBMODULE_NOTE = 'Submodule changes are not shown by git_read.'
export const GIT_READ_FAILED_TEXT = 'git_read: git ended abnormally.'

/** Fixed texts for every refusal. None of them carries input or repository bytes. */
export const GIT_READ_REFUSALS: Readonly<Record<GitReadRefusalCategory, string>> = {
  config_runs_programs:
    "git_read did not run: this repository's git configuration has settings git_read does not accept (such as drivers, filters, includes, aliases or signing tools). Run git with shell_exec instead; the user may be asked to approve it.",
  preflight_failed: "git_read could not read this repository's configuration.",
  not_a_repository:
    'No git repository at this directory (git_read does not use bare or plain-file git directories).',
  directory_outside_workspace:
    'The repository, its object store or a file it links to is outside the workspace.',
  directory_protected: 'The repository or its object store is inside platform-managed state.',
  alternates_unsupported:
    "This repository's object-store alternates file uses a form git_read does not read (quoted, unusual whitespace, too deep or too large). Run git with shell_exec instead; the user may be asked to approve it.",
  alternates_unresolved:
    "An object store listed in this repository's alternates file does not exist.",
  alternates_unreadable: "This repository's object-store alternates file could not be read.",
  repository_link_unresolved: "A link inside this repository's .git directory does not resolve.",
  repository_too_large:
    "This repository's .git directory has more entries than git_read checks (200,000).",
  root_unavailable: 'git_read unavailable: no verified caller workspace.',
  bad_path: "Paths must be workspace-relative, without '..' or a leading '-', ':' or '/'.",
  path_missing:
    'That file is not in the worktree; git_read blames only files present in the workspace.',
  not_a_commit:
    'Revisions for show, cat_file, diff and grep must name commits (or COMMIT:path for show and cat_file); blob and tree ids are not accepted.',
  protected_history:
    'This file was renamed from platform-managed state; git_read does not follow its history.',
  timeout: 'git_read timed out.',
  notes_history: 'That revision is in git notes history, which git_read does not read.',
  index_path_unsafe:
    "This repository's index names a path outside the worktree, so git_read does not read the worktree. Name a revision (for example HEAD) to read committed content.",
  worktree_link:
    "A directory in this repository's worktree is a link, so git_read does not search the worktree. Name a revision (for example HEAD) to search committed content.",
}

export interface GitReadToolOptions {
  /** The workspace root, the same root `file_read` uses. */
  root: string
  /** The probe's absolute git path; `execFile` never searches PATH. */
  gitPath: string
  timeoutMs: number
  /** True for a Host-owned GFS store: the caller root is re-verified on every call. */
  verifyCallerRoot: boolean
  /** Test seam: every git process goes through it. */
  spawn?: GitSpawn
}

function cut(text: string): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= GIT_READ_MAX_RESULT_BYTES) return { text, cut: false }
  // Cut on a byte budget, then drop a split trailing character.
  const head = bytes.subarray(0, GIT_READ_MAX_RESULT_BYTES).toString('utf8').replace(/�$/, '')
  return { text: head, cut: true }
}

function withTruncation(text: string, truncated: boolean): string {
  if (!truncated) return text
  return `${text}${text.endsWith('\n') ? '' : '\n'}${GIT_READ_TRUNCATED_LINE}`
}

/**
 * Read-only git in a workspace repository, without a shell: a fixed argv per
 * subcommand, a literal environment, and a preflight that keeps git inside the
 * workspace and away from protected content and from anything that runs
 * programs. Approval follows `shell_exec` and `file_read` (`approvalAlso`),
 * and guardrail `file_read` rules apply to its declared reads (`fileReads`).
 */
export class GitReadTool implements Tool {
  private readonly spawn: GitSpawn

  constructor(private readonly options: GitReadToolOptions) {
    this.spawn = options.spawn ?? spawnGit
  }

  name(): string {
    return GIT_READ_TOOL_NAME
  }
  description(): string {
    return GIT_READ_DEFINITION.description
  }
  parametersSchema(): Record<string, unknown> {
    return GIT_READ_DEFINITION.parameters as unknown as Record<string, unknown>
  }
  requiresSanitization(): boolean {
    return true
  }
  requiresApproval(): boolean {
    return true
  }
  validateParams(params: Record<string, unknown>): ValidationResult {
    return validateGitReadParams(params)
  }
  approvalAlso(): readonly string[] {
    return ['shell_exec', 'file_read']
  }
  fileReads(params: Record<string, unknown>): FileReads | undefined {
    return gitReadFileReads(params)
  }

  async execute(params: Record<string, unknown>, context?: ExecutionContext): Promise<ToolOutput> {
    context?.signal?.throwIfAborted()
    const started = Date.now()
    const done = (content: string, isError: boolean): ToolOutput => ({
      content,
      duration_ms: Date.now() - started,
      is_error: isError,
    })
    const check = checkGitReadParams(params)
    if (!check.ok) return done(`Parameter validation failed: ${check.text}`, true)
    const timeoutMs = Math.min(this.options.timeoutMs, context?.timeoutMs ?? this.options.timeoutMs)

    const preflight = await runPreflight({
      root: this.options.root,
      verifyCallerRoot: this.options.verifyCallerRoot,
      gitPath: this.options.gitPath,
      params: check.params,
      timeoutMs,
      spawn: this.spawn,
      ...(context?.signal ? { signal: context.signal } : {}),
    })
    context?.signal?.throwIfAborted()
    if (preflight.kind === 'refused') return this.refused(preflight.category, done)
    if (preflight.kind === 'git_failed') return done(cut(preflight.stderr).text, true)

    const run = (argv: readonly string[], maxBuffer: number): Promise<GitSpawnResult> =>
      this.spawn(this.options.gitPath, argv, {
        cwd: preflight.cwd,
        env: preflight.env,
        timeoutMs,
        maxBuffer,
        ...(context?.signal ? { signal: context.signal } : {}),
      })

    const result = await run(buildGitReadArgv(check.params), GIT_MAX_BUFFER)
    context?.signal?.throwIfAborted()
    switch (result.outcome) {
      case 'timeout':
        return this.refused('timeout', done)
      case 'aborted':
        return done('git_read was stopped.', true)
      case 'error':
        return done('git_read could not start git.', true)
      case 'failed':
        return done(GIT_READ_FAILED_TEXT, true)
      case 'overflow': {
        const out = cut(result.stdout)
        return done(withTruncation(out.text, true), false)
      }
      case 'exited':
        break
    }
    if (result.exitCode !== 0) {
      // grep and merge-base exit 1 with nothing on stderr for "no match".
      if (
        result.exitCode === 1 &&
        result.stderr.length === 0 &&
        (check.params.subcommand === 'grep' || check.params.subcommand === 'merge_base')
      ) {
        return done('', false)
      }
      const stderr =
        result.stderr.length > 0 ? result.stderr : `git exited with code ${result.exitCode}.`
      return done(cut(stderr).text, true)
    }
    // rev-parse echoes the closing `--` the argv adds; drop it.
    const stdout =
      check.params.subcommand === 'rev_parse'
        ? result.stdout.replace(/(^|\n)--\n?$/, '$1')
        : result.stdout
    const out = cut(stdout)
    let content = withTruncation(out.text, out.cut)
    if (await this.hasSubmodules(check.params, run)) {
      content = `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}${GIT_READ_SUBMODULE_NOTE}`
    }
    return done(content, false)
  }

  private refused(
    category: GitReadRefusalCategory,
    done: (content: string, isError: boolean) => ToolOutput
  ): ToolOutput {
    logger.info({ event: 'git_read_refused', category }, 'git_read refused a call')
    return done(GIT_READ_REFUSALS[category], true)
  }

  /** `status` and `diff` skip submodules; say so when the index has gitlinks. */
  private async hasSubmodules(
    params: GitReadParams,
    run: (argv: readonly string[], maxBuffer: number) => Promise<GitSpawnResult>
  ): Promise<boolean> {
    if (params.subcommand !== 'status' && params.subcommand !== 'diff') return false
    // The whole index (`:/`), as status and diff report from a subdirectory.
    const index = await run(['ls-files', '--stage', '--', ':/'], SUBMODULE_INDEX_MAX_BUFFER)
    if (index.outcome !== 'exited' || index.exitCode !== 0) {
      // The note is advisory; the call's own result is already complete.
      logger.debug(
        { event: 'git_read_submodule_check_skipped', outcome: index.outcome },
        'git_read submodule check skipped'
      )
      return false
    }
    return index.stdout.split('\n').some(line => line.startsWith('160000 '))
  }
}
