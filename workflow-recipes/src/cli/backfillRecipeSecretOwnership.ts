#!/usr/bin/env node
// Issue #637 back-fill CLI — stamps `clerum.io/owner-recipe=<recipe>` on
// pre-existing recipe Secrets that predate the ownership-label model and would be
// fail-closed-denied by the WRC reconciler (prod incident 2026-06-26: leadforge +
// agentic-task-board plugins broke because leadforge-mcp-credentials / atb-secrets
// were unlabeled). The decision logic lives in the unit-tested
// `planSecretOwnershipBackfill`; this file only does cluster I/O via kubectl.
//
// DRY-RUN by default — prints the plan and exits without mutating. Pass `--apply`
// to label. Against a prod context `--apply` additionally requires CONFIRM=yes.
//
// Usage:
//   node dist/cli/backfillRecipeSecretOwnership.js --context <ctx>            # dry-run
//   CONFIRM=yes node dist/cli/backfillRecipeSecretOwnership.js --context <ctx> --apply
import { execFileSync } from 'node:child_process'
import { OWNER_RECIPE_LABEL_KEY, SHARED_LABEL_KEY } from '@clerum/workflow-runtime-core'
import {
  type BackfillNamespaces,
  type SecretLabelReader,
  isProdContext,
  isUnlabeled,
  mapRecipeListToBackfillRecipes,
  planSecretOwnershipBackfill,
} from '../reconciler/secretOwnershipBackfill'

interface Args {
  context: string
  apply: boolean
}

function parseArgs(argv: string[]): Args {
  let context = ''
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--context') context = argv[++i] ?? ''
    else if (argv[i] === '--apply') apply = true
  }
  return { context, apply }
}

const NAMESPACES: BackfillNamespaces = {
  mcpServer: process.env.CLERUM_MCP_SERVER_NAMESPACE ?? 'mcp-server',
  sandboxUi: process.env.CLERUM_SANDBOX_UI_NAMESPACE ?? 'sandbox-ui',
  sandbox: process.env.CLERUM_SANDBOX_NAMESPACE ?? 'sandbox-recipes',
}

function kubectl(context: string, args: string[]): string {
  return execFileSync('kubectl', ['--context', context, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

function jsonpathLabelKey(key: string): string {
  return key.replace(/\./g, '\\.')
}

const OWNER_RECIPE_JSONPATH_LABEL_KEY = jsonpathLabelKey(OWNER_RECIPE_LABEL_KEY)
const SHARED_JSONPATH_LABEL_KEY = jsonpathLabelKey(SHARED_LABEL_KEY)

const SINGLE_OWNERSHIP_LABELS_JSONPATH =
  `{.metadata.name}{"\\t"}` +
  `{.metadata.labels.${OWNER_RECIPE_JSONPATH_LABEL_KEY}}{"\\t"}` +
  `{.metadata.labels.${SHARED_JSONPATH_LABEL_KEY}}`

function cleanJsonpathValue(value: string | undefined): string {
  return value && value !== '<no value>' ? value : ''
}

function ownershipLabels(
  owner: string | undefined,
  shared: string | undefined
): Record<string, string> {
  const labels: Record<string, string> = {}
  const ownerValue = cleanJsonpathValue(owner)
  const sharedValue = cleanJsonpathValue(shared)
  if (ownerValue) labels[OWNER_RECIPE_LABEL_KEY] = ownerValue
  if (sharedValue) labels[SHARED_LABEL_KEY] = sharedValue
  return labels
}

/** Reads only ownership label metadata for the referenced Secret requested by the planner. */
function buildSecretReader(context: string): SecretLabelReader {
  return (namespace, name) => readCurrentSecretLabels(context, namespace, name)
}

function readCurrentSecretLabels(
  context: string,
  namespace: string,
  name: string
): Record<string, string> | null {
  const output = kubectl(context, [
    '-n',
    namespace,
    'get',
    'secret',
    name,
    '--ignore-not-found',
    `-o=jsonpath=${SINGLE_OWNERSHIP_LABELS_JSONPATH}`,
  ])
  const [currentName, owner, shared] = output.split('\t')
  if (!currentName) return null
  return ownershipLabels(owner, shared)
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node dist/cli/<command>.js --context <ctx> [--apply]')
    return
  }
  const { context, apply } = parseArgs(process.argv.slice(2))
  if (!context) {
    console.error('ERROR: --context <kubectl-context> is required.')
    process.exit(2)
  }
  if (apply && isProdContext(context) && process.env.CONFIRM !== 'yes') {
    console.error(
      `ERROR: refusing to --apply against prod context "${context}" without CONFIRM=yes.`
    )
    process.exit(2)
  }

  console.error(`[backfill-637] context=${context} mode=${apply ? 'APPLY' : 'DRY-RUN'}`)

  const recipesJson = JSON.parse(
    kubectl(context, ['get', 'workflowrecipes', '-A', '-o', 'json'])
  ) as {
    items?: unknown[]
  }
  const recipes = mapRecipeListToBackfillRecipes(recipesJson.items ?? [])
  const reader = buildSecretReader(context)

  const plan = planSecretOwnershipBackfill(recipes, NAMESPACES, reader)

  console.log(`\nRecipes scanned: ${recipes.length}`)
  console.log(`To stamp (unlabeled, single-owner): ${plan.stamp.length}`)
  for (const s of plan.stamp)
    console.log(`  + ${s.namespace}/${s.secret}  owner-recipe=${s.ownerRecipe}`)
  console.log(`Already labeled (skipped): ${plan.alreadyLabeled.length}`)
  for (const a of plan.alreadyLabeled)
    console.log(`  = ${a.namespace}/${a.secret}  (${a.ownership})`)
  console.log(`Missing in referenced ns (skipped): ${plan.missing.length}`)
  for (const m of plan.missing) console.log(`  ? ${m.namespace}/${m.secret}`)
  console.log(`AMBIGUOUS — referenced by >1 recipe, NEEDS MANUAL REVIEW: ${plan.ambiguous.length}`)
  for (const am of plan.ambiguous)
    console.log(
      `  ! ${am.namespace}/${am.secret}  referenced by: ${am.recipes.join(', ')}` +
        `  → mark clerum.io/shared=true if intentionally shared, else split per recipe`
    )

  if (!apply) {
    console.log(
      `\nDRY-RUN — no changes applied. Re-run with --apply to stamp the ${plan.stamp.length} secret(s) above.`
    )
    return
  }

  let applied = 0
  let failedWrites = 0
  for (const s of plan.stamp) {
    const currentLabels = readCurrentSecretLabels(context, s.namespace, s.secret)
    if (currentLabels === null) {
      console.warn(`  skipped ${s.namespace}/${s.secret}: no longer exists`)
      continue
    }
    if (!isUnlabeled(currentLabels)) {
      console.warn(`  skipped ${s.namespace}/${s.secret}: ownership changed after planning`)
      continue
    }
    try {
      kubectl(context, [
        '-n',
        s.namespace,
        'label',
        'secret',
        s.secret,
        `${OWNER_RECIPE_LABEL_KEY}=${s.ownerRecipe}`,
      ])
    } catch {
      failedWrites++
      console.warn(`  skipped ${s.namespace}/${s.secret}: label write failed`)
      continue
    }
    console.log(`  labeled ${s.namespace}/${s.secret} -> owner-recipe=${s.ownerRecipe}`)
    applied++
  }
  console.log(`\nApplied ${applied} ownership label(s).`)
  if (plan.ambiguous.length > 0) {
    console.log(
      `WARNING: ${plan.ambiguous.length} ambiguous secret(s) were NOT touched — review the list above.`
    )
  }
  if (failedWrites > 0) {
    console.warn(
      `WARNING: ${failedWrites} label write(s) failed — re-run after reviewing kubectl errors.`
    )
    process.exit(1)
  }
}

main()
