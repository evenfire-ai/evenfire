#!/usr/bin/env node
// Render guard for ghcr mode. Asserts that a rendered ghcr overlay actually
// resolved: no clerum/ image REFERENCE survives, and every resolved
// ghcr.io/evenfire-ai ref carries the pinned tag.
//
// Asserting the resolved tag (not merely the absence of clerum/) is what makes
// this an INDEPENDENT observation of the release coordinate: it reads the
// artifact the overlay produced, rather than re-reading the field
// prepare-release.mjs wrote.
//
//   node scripts/ci/check-ghcr-render.mjs rendered.yaml [more.yaml ...]
//        [--component deploy/components/ghcr-images/kustomization.yaml]
//        [--expect-tag v0.6.0]
//
// It matches FIELDS, not raw strings. Six clerum/ substrings survive a
// CORRECT render of the committed minikube-ghcr / minikube-no-uis-ghcr
// overlays, so a "zero clerum/ strings" guard is unsatisfiable:
//   - three lines that are not `image:`/`value:` fields at all and are
//     skipped naturally: one volume mountPath (/etc/clerum/...) and two
//     ConfigMap `data:` key-value lines (a `KEY: ...clerum/...` mapping,
//     not a YAML `value:` key) -- the built-in image transformer never
//     touches ConfigMap data, only container `image:`/env `value:` fields
//   - three prefix-allowlist / opt-in-local-build env `value:` fields,
//     enumerated below in EXCEPTIONS. Every entry here is verified against
//     the REAL rendered minikube-ghcr overlay -- an env var that only ever
//     appears as a ConfigMap `data:` key (never a literal `value:` field)
//     does not belong here, no matter how closely its name/value resembles
//     a real exception: it would be a dead escape hatch in a guard whose
//     job is to fail closed.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_COMPONENT = 'deploy/components/ghcr-images/kustomization.yaml'
const GHCR_PREFIX = 'ghcr.io/evenfire-ai/'

// Every clerum/ value allowed to survive, keyed by env-var name and pinned to
// its EXACT value. Name-only entries would wave through a genuinely broken
// rewrite that happened to land on the same env var.
const EXCEPTIONS = new Map([
  // Tag-prefix allowlist with an EMPTY tag. workflow-custom-sdk-e2e is
  // published:false, therefore not pull_in_ghcr_mode, therefore it has no
  // component row and stays a local build -- so this prefix must stay clerum/.
  // It survives because no row exists, not because the transformer cannot
  // match it: add a row and kustomize rewrites this to
  // ghcr.io/evenfire-ai/workflow-custom-sdk-e2e:v0.6.0, appending a tag and
  // silently breaking the prefix match.
  ['WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES', 'clerum/workflow-custom-sdk-e2e:'],
  // mcp-host-desktop is deployed_to_minikube:false, so it gets no component
  // row. It is an opt-in local build in BOTH modes
  // (MINIKUBE_BUILD_DESKTOP_IMAGE=true), so this ref is not a ghcr-mode
  // regression -- it is the same ref local mode renders.
  ['CONTEXT_MAPPER_DESKTOP_IMAGE', 'clerum/mcp-host-desktop:test'],
  // A comma-separated PREFIX allowlist, not an image ref -- it already
  // permits the ghcr namespace, which is why ghcr-mode pods pass this
  // policy. This is host-context-controller's OWN copy
  // (deploy/base/control-plane/host-context-controller.yaml:115-116),
  // inlined as a literal env value. control-api carries the identical
  // string too (deploy/base/control-plane/configmaps.yaml), but ONLY as a
  // ConfigMap `data:` key consumed via `envFrom` -- it never renders as a
  // literal `value:` field, so it is deliberately NOT an entry here: a
  // name that can never match a real `value:` line is a dead escape hatch
  // in a guard whose job is to fail closed.
  [
    'CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES',
    'ghcr.io/evenfire-ai/,mongodb/,mcr.microsoft.com/,clerum/',
  ],
])

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

function die(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

// Positional args are the rendered files. Drop the flags AND the values that
// follow them by index, rather than by value: filtering by value would also
// drop a rendered file that happened to share a string with a flag value.
const FLAGS = new Set(['--component', '--expect-tag'])
const renderFiles = []
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (FLAGS.has(arg)) {
    i += 1 // skip its value
    continue
  }
  if (arg.startsWith('--')) continue
  renderFiles.push(arg)
}

if (renderFiles.length === 0) {
  die('no rendered files given; usage: check-ghcr-render.mjs <rendered.yaml> [more.yaml ...]')
}

let expectedTag = argValue('--expect-tag')
if (!expectedTag) {
  const componentPath = argValue('--component') || path.join(process.cwd(), DEFAULT_COMPONENT)
  let componentRaw
  try {
    componentRaw = fs.readFileSync(componentPath, 'utf8')
  } catch (error) {
    die(`could not read the ghcr component at ${componentPath}: ${error.message}`)
  }
  // Guarded: an unguarded match(...)[1] here would throw on a restructured
  // component and, with stderr swallowed, could read as a pass.
  const tags = [...componentRaw.matchAll(/^\s+newTag:\s*(\S+)\s*$/gm)].map(x => x[1])
  if (tags.length === 0) {
    die(
      `${componentPath} has no \`newTag:\` lines, so there is no pin to compare the render against`
    )
  }
  const distinct = [...new Set(tags)]
  // > 1, not !== 1: this check and the tags.length === 0 check above must be
  // DISJOINT conditions, or a component with zero newTag: lines trips both
  // and neither is independently provable by mutation testing (removing
  // either alone still dies, just via the other's message, which happens to
  // reuse the substring "newTag"). tags.length >= 1 is already guaranteed
  // here (the die() above is fatal), so distinct.length is never 0 at this
  // point -- "mixed" only means "more than one distinct value".
  if (distinct.length > 1) {
    die(
      `${componentPath} carries mixed newTag values (${distinct.join(', ')}); the pin must be one tag`
    )
  }
  expectedTag = distinct[0]
}

const problems = []
let ghcrRefsSeen = 0

// A container image field. Both `image: x` and `- image: x` forms appear in a
// rendered manifest (the latter inside a containers list rendered inline).
const IMAGE_FIELD = /^\s*-?\s*image:\s*'?"?([^\s'"]+)'?"?\s*$/
// An env-var value field.
const VALUE_FIELD = /^\s*value:\s*'?"?(.*?)'?"?\s*$/
// Env-var names are SCREAMING_SNAKE, which is what separates them from resource
// `name:` keys (control-ui, control-api) in the same rendered stream.
const ENV_NAME_FIELD = /^\s*-?\s*name:\s*([A-Z][A-Z0-9_]*)\s*$/
const GHCR_REF = /ghcr\.io\/evenfire-ai\/[a-z0-9][a-z0-9._-]*:([A-Za-z0-9._-]+)/g

function checkGhcrTags(where, text) {
  for (const match of text.matchAll(GHCR_REF)) {
    ghcrRefsSeen += 1
    if (match[1] !== expectedTag) {
      problems.push(
        `${where}: resolved tag is ${match[1]}, expected the pinned ${expectedTag} (${match[0]})`
      )
    }
  }
}

for (const file of renderFiles) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    die(`could not read the rendered file ${file}: ${error.message}`)
  }
  const lines = raw.split('\n')
  let lastEnvName = ''

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const where = `${file}:${i + 1}`

    const envName = line.match(ENV_NAME_FIELD)
    if (envName) lastEnvName = envName[1]

    const imageField = line.match(IMAGE_FIELD)
    if (imageField) {
      const ref = imageField[1]
      // No exceptions for container images. Every clerum/* container image in
      // these overlays has a component row, so a survivor means the rewrite
      // did not happen and the pod would ImagePullBackOff.
      if (ref.includes('clerum/') && !ref.startsWith(GHCR_PREFIX)) {
        problems.push(`${where}: container image ${ref} was not rewritten to ${GHCR_PREFIX}*`)
      }
      checkGhcrTags(where, ref)
      continue
    }

    const valueField = line.match(VALUE_FIELD)
    if (valueField) {
      const value = valueField[1]
      if (value.includes('clerum/')) {
        const allowed = EXCEPTIONS.get(lastEnvName)
        if (allowed === undefined) {
          problems.push(
            `${where}: env ${lastEnvName || '(unknown)'} value "${value}" still names clerum/ and is not a ` +
              `documented exception. If it is a prefix allowlist or an opt-in local build, add it to ` +
              `EXCEPTIONS in scripts/ci/check-ghcr-render.mjs with a comment saying why; otherwise its ` +
              `image lost its component row.`
          )
        } else if (allowed !== value) {
          problems.push(
            `${where}: env ${lastEnvName} is a documented exception but its value drifted: ` +
              `got "${value}", the exception pins "${allowed}"`
          )
        }
      }
      checkGhcrTags(where, value)
    }
  }
}

// A guard that observed nothing is broken, not green: an empty file, a wrong
// path, or a render that silently produced no workloads must be a red run.
if (ghcrRefsSeen === 0) {
  die(
    `scanned ${renderFiles.length} file(s) and found zero ${GHCR_PREFIX}* references. ` +
      `Either the wrong files were passed or the ghcr component did not apply; ` +
      `a render with no rewritten images is a failure, not a pass.`
  )
}

if (problems.length > 0) {
  console.error(
    `::error::ghcr render guard found ${problems.length} problem(s) across ${renderFiles.length} file(s)`
  )
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

console.log(
  `ghcr render guard: ${ghcrRefsSeen} image reference(s) across ${renderFiles.length} file(s), all at ${expectedTag}`
)
