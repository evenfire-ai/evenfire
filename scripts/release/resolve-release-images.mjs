// Decides which digest a release promotes for ONE image, and refuses rather
// than guessing.
//
//   node scripts/release/resolve-release-images.mjs \
//     --image control-api --source-paths 'control-api/**' --tag-sha <sha>
//
// Prints the digest to promote on success; exits non-zero with a named reason
// otherwise.
//
// Why the revision annotation and not git history: builds are change-detected, so
// each image's newest sha- tag sits at a different commit, and the tagged
// commit on main is a dev->main merge that was never built. Computing "the last
// commit touching this image's source paths" lands on feature-branch merge
// commits that have no published image at all. The image knows what it was
// built from; ask it.
//
// Reads the revision from the OCI INDEX's own annotations (`crane manifest`),
// not a per-arch child manifest's config label (`crane config --platform`).
// build-publish.yml (Task 3) writes the same value to both: an index-level
// `--annotation index:org.opencontainers.image.revision=...` on the merged
// manifest list, and a per-leg `labels:` baked into each platform's image
// config. The index read is one flat lookup with no --platform to get wrong
// (`crane config --platform linux/amd64` would break if that leg's manifest
// were ever the one missing while another platform's was present).
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { argValue } from './release-coordinates.mjs'

const REGISTRY = 'ghcr.io/evenfire-ai'

function die(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const image = argValue('--image')
const sourcePaths = argValue('--source-paths')
const tagSha = argValue('--tag-sha')

if (!image || !tagSha) die('--image and --tag-sha are required')

// Resolve the moving tag to an immutable digest ONCE. :latest is re-pointed on
// every dev push, so reading it twice -- once to verify, once to copy -- can
// verify one image and promote another.
let digest
try {
  digest = sh('crane', ['digest', `${REGISTRY}/${image}:latest`])
} catch (error) {
  die(`${image}: could not resolve ${REGISTRY}/${image}:latest to a digest: ${error.message}`)
}

let revision
try {
  const manifest = JSON.parse(sh('crane', ['manifest', `${REGISTRY}/${image}@${digest}`]))
  revision = manifest?.annotations?.['org.opencontainers.image.revision']
} catch (error) {
  die(`${image}: could not read the image manifest at ${digest}: ${error.message}`)
}

if (!revision) {
  die(
    `${image}@${digest} carries no org.opencontainers.image.revision annotation, so there is no way ` +
      `to tell what it was built from. This usually means it is not a multi-arch index produced by ` +
      `build-publish.yml's merge step (a lone single-platform push has no index to annotate) or it ` +
      `predates that step recording one -- re-publish via a build_all run so the merge step writes it.`
  )
}

// A well-formed revision that simply is not an object in this checkout (a
// shallow clone, an unfetched ref, or a stray hand-edited annotation) makes
// BOTH --is-ancestor calls below throw -- with nothing to distinguish it from
// genuinely diverged history, this used to fall through to the "diverged
// history" message even though there was no comparison to make at all.
// Existence is checked first, and separately, so that message stays reserved
// for when it is actually true.
try {
  sh('git', ['cat-file', '-e', `${revision}^{commit}`])
} catch {
  die(
    `${image}: the published image records revision ${revision}, but this checkout has no such commit ` +
      `at all -- distinct from diverged history, where the commit exists yet neither side descends from ` +
      `the other. A shallow clone, an unfetched ref, or a stray hand-edited annotation could all cause ` +
      `this; fetch the missing commit (or its full history) into this checkout and retry.`
  )
}

try {
  sh('git', ['merge-base', '--is-ancestor', revision, tagSha])
} catch {
  // Not-an-ancestor covers two different situations, and only one of them is
  // "this image is stale": revision could be a DESCENDANT of tagSha (:latest
  // raced ahead on dev after tagSha was already tagged -- no merge fixes an
  // already-tagged historical commit into descending from a later one), or
  // the two commits could share no ancestry at all (diverged history, e.g. a
  // hotfix cut from an older base while dev moved on). Run the reverse check
  // to tell them apart instead of assuming staleness in both.
  let revisionIsDescendant = false
  try {
    sh('git', ['merge-base', '--is-ancestor', tagSha, revision])
    revisionIsDescendant = true
  } catch {
    // Neither is an ancestor of the other -- diverged history.
  }

  if (revisionIsDescendant) {
    die(
      `${image}: the published image was built from ${revision}, which comes AFTER the release ` +
        `commit ${tagSha} (it descends from it), not before -- :latest moved ahead on dev after ` +
        `${tagSha} was already tagged. This is not a stale image and merging will not help, since ` +
        `${tagSha} is fixed history now. Either cut the release tag from a commit that already ` +
        `includes ${revision}, or wait for a fresh dev-proven build whose revision predates ${tagSha}.`
    )
  }

  die(
    `${image}: the published image was built from ${revision}, which shares no ancestry with the ` +
      `release commit ${tagSha} -- they are on diverged history, so neither descends from the other. ` +
      `Re-publish the image from a commit that is actually an ancestor of ${tagSha}, then cut the ` +
      `release tag again.`
  )
}

if (sourcePaths) {
  // Guarded separately from the ancestor check above: an invalid or
  // unresolvable revision must die with a message this script chose, not an
  // uncaught `git diff` stack trace. Without this, removing the ancestor
  // check upstream doesn't redden a test for the ancestor check -- it
  // crashes here instead, and a test that only asserts "some failure
  // happened" can't tell the difference.
  let changed
  try {
    changed = sh('git', ['diff', '--name-only', revision, tagSha, '--', ...sourcePaths.split(',')])
  } catch (error) {
    die(`${image}: could not diff ${revision}..${tagSha} for source changes: ${error.message}`)
  }
  if (changed) {
    die(
      `${image}: source changed after the published image (${revision}). Push to dev and let ` +
        `build-publish run before tagging.\nchanged:\n${changed}`
    )
  }
}

console.log(digest)
