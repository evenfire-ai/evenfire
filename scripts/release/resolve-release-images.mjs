// Decides which digest a release promotes for ONE image, and refuses rather
// than guessing.
//
//   node scripts/release/resolve-release-images.mjs \
//     --image control-api --source-paths 'control-api/**' --tag-sha <sha>
//
// Prints `<digest>\t<candidate tag>` on success -- the digest to promote and
// the registry tag it was resolved through. Prints nothing on stdout and
// exits non-zero with a named reason otherwise.
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
//
// The candidate chain: candidates() yields registry tags in priority order
// (:latest, then the previous release's version tag), and
// evaluateCandidate() checks each one. Every outcome of that check is one of
// two kinds, and a bare `catch` cannot tell them apart:
//   - Reject the candidate, and try the next one. The tag does not exist
//     (crane says MANIFEST_UNKNOWN), carries no revision annotation, was built
//     from a commit that is not an ancestor of the release commit, or its
//     source changed since. When every candidate is rejected the image is
//     refused, with each candidate's reason and the remedy.
//   - Fail the image (ImageFailure), with no further candidates. Any other
//     registry error (auth, rate limit, unknown repository, network, an
//     unparsable manifest), a revision this checkout does not have, or a git
//     error. None of these says anything about the candidate itself, so
//     falling through would let a transient error promote an older image.
//     The candidates rejected before the error are listed with it.
// Candidates are generated lazily, so a release whose first candidate passes
// makes no registry call for any later one, and does not look up the
// previous release at all.
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { argValue, compareVersions } from './release-coordinates.mjs'

const REGISTRY = 'ghcr.io/evenfire-ai'
const REVISION_ANNOTATION = 'org.opencontainers.image.revision'
// A strict release tag. rc and other pre-release tags never match.
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/

// An outcome that says nothing about the candidate being checked, so the
// whole image fails instead of moving on to the next candidate. Messages are
// relative to the image; main() prefixes its name.
class ImageFailure extends Error {}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// "<cmd> <args> failed (exit N): <stderr>" for a process that did not exit 0.
function failed(cmd, args, result) {
  let how = `exit ${result.status}`
  if (result.error) how = `could not start: ${result.error.message}`
  else if (result.signal) how = `signal ${result.signal}`
  const stderr = (result.stderr ?? '').trim()
  return `${[cmd, ...args].join(' ')} failed (${how})${stderr ? `: ${stderr}` : ''}`
}

// Resolves a tag to an immutable digest. Returns null only when the registry
// says the manifest is unknown, i.e. the tag does not exist. Every other
// failure throws: an auth error, a rate limit or an unknown repository says
// nothing about whether the tag exists. crane's HEAD-fallback line can show a
// bare 404 as well; that alone is not taken as "not found".
function craneDigest(ref) {
  const result = run('crane', ['digest', ref])
  if (result.status === 0) {
    const digest = result.stdout.trim()
    if (digest) return digest
    throw new ImageFailure(`crane digest ${ref} exited 0 but printed no digest`)
  }
  if (result.status !== null && (result.stderr ?? '').includes('MANIFEST_UNKNOWN')) return null
  throw new ImageFailure(failed('crane', ['digest', ref], result))
}

// The revision the index at <digest> records, or null when it records none.
// A digest that was just resolved must be readable, so any fetch or parse
// error throws.
function craneRevision(image, digest) {
  const ref = `${REGISTRY}/${image}@${digest}`
  const result = run('crane', ['manifest', ref])
  if (result.status !== 0) {
    throw new ImageFailure(
      `could not read the image manifest at ${digest}: ${failed('crane', ['manifest', ref], result)}`
    )
  }
  let manifest
  try {
    manifest = JSON.parse(result.stdout)
  } catch (error) {
    throw new ImageFailure(`could not read the image manifest at ${digest}: ${error.message}`)
  }
  // JSON that is not an object (null, an array, a number) is not an index
  // either. Reading it as "no annotation" would reject the candidate and move
  // on, when the registry answer itself is broken.
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    const got =
      manifest === null ? 'null' : Array.isArray(manifest) ? 'an array' : `a ${typeof manifest}`
    throw new ImageFailure(
      `could not read the image manifest at ${digest}: expected a JSON object, got ${got}`
    )
  }
  const revision = manifest.annotations?.[REVISION_ANNOTATION]
  return typeof revision === 'string' && revision !== '' ? revision : null
}

// Runs a git command whose exit status is the answer: 0 for yes, 1 for no.
// Anything else -- 128 for a bad object or a broken checkout, a signal, git
// not starting at all -- is an error and not a "no", so it throws.
function gitStatus(args) {
  const result = run('git', args)
  if (result.status === 0 || result.status === 1) return result.status
  throw new ImageFailure(failed('git', args, result))
}

// Runs a git command for its output. Any non-zero exit is an error.
function gitOutput(args) {
  const result = run('git', args)
  if (result.status !== 0) throw new ImageFailure(failed('git', args, result))
  return result.stdout
}

// The previous release of the release commit tagSha, or null when there is
// none: the highest strict vX.Y.Z tag reachable from tagSha, compared as
// numbers. Tags on tagSha itself are left out, since they name the release
// being cut. This comes from git ancestry, not from the version being
// released, so a dry run given a raw sha finds the same tag, and so does a
// release that skipped a patch number.
function previousRelease(tagSha) {
  const lines = text => text.split('\n').filter(Boolean)
  const onTagCommit = new Set(lines(gitOutput(['tag', '--points-at', tagSha])))
  let best = null
  for (const tag of lines(gitOutput(['tag', '--merged', tagSha, '--list', 'v*']))) {
    if (!RELEASE_TAG_RE.test(tag) || onTagCommit.has(tag)) continue
    if (best === null || compareVersions(tag.slice(1), best.slice(1)) > 0) best = tag
  }
  return best
}

// Checks one candidate tag of one image against the release commit. Returns
// { ok: true, digest } or { ok: false, reason }; throws ImageFailure when the
// answer is an error rather than a verdict on this candidate.
function evaluateCandidate({ image, tag, tagSha, sourcePaths }) {
  // Resolve the tag to an immutable digest ONCE, and read everything else
  // through the digest. A tag like :latest is re-pointed on every dev push,
  // so reading it twice -- once to verify, once to copy -- can verify one
  // image and promote another.
  const ref = `${REGISTRY}/${image}:${tag}`
  const digest = craneDigest(ref)
  if (digest === null) {
    let reason = `${ref} does not exist (the registry answered MANIFEST_UNKNOWN)`
    if (RELEASE_TAG_RE.test(tag)) {
      // A release tag whose promotion failed still counts as the previous
      // release, so every image that needs this fallback is refused until it
      // is cleared.
      reason +=
        `. Either ${image} was first published after ${tag}, or the ${tag} promotion failed ` +
        `and left its git tag behind: delete a failed release tag and push the same version ` +
        `again at the fixed commit.`
    }
    return { ok: false, reason }
  }

  const revision = craneRevision(image, digest)
  if (revision === null) {
    return {
      ok: false,
      reason:
        `${image}@${digest} carries no org.opencontainers.image.revision annotation, so there is no way ` +
        `to tell what it was built from. This usually means it is not a multi-arch index produced by ` +
        `build-publish.yml's merge step (a lone single-platform push has no index to annotate) or it ` +
        `predates that step recording one -- re-publish via a build_all run so the merge step writes it.`,
    }
  }

  // A well-formed revision that simply is not an object in this checkout (a
  // shallow clone, an unfetched ref, or a stray hand-edited annotation) makes
  // BOTH --is-ancestor calls below exit 128. Existence is checked first, and
  // separately, so the "diverged history" message stays reserved for when it
  // is actually true. A missing commit fails the image rather than rejecting
  // the candidate: the checkout is incomplete, which affects every candidate.
  // --end-of-options keeps an annotation that starts with "-" from being read
  // as an option.
  const revisionExists = gitStatus([
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${revision}^{commit}`,
  ])
  if (revisionExists === 1) {
    throw new ImageFailure(
      `the published image records revision ${revision}, but this checkout has no such commit ` +
        `at all -- distinct from diverged history, where the commit exists yet neither side descends from ` +
        `the other. A shallow clone, an unfetched ref, or a stray hand-edited annotation could all cause ` +
        `this; fetch the missing commit (or its full history) into this checkout and retry.`
    )
  }

  if (gitStatus(['merge-base', '--is-ancestor', revision, tagSha]) === 1) {
    // Not-an-ancestor covers two different situations, and only one of them is
    // "this image is stale": revision could be a DESCENDANT of tagSha (:latest
    // raced ahead on dev after tagSha was already tagged -- no merge fixes an
    // already-tagged historical commit into descending from a later one), or
    // the two commits could share no ancestry at all (diverged history, e.g. a
    // hotfix cut from an older base while dev moved on). Run the reverse check
    // to tell them apart instead of assuming staleness in both.
    if (gitStatus(['merge-base', '--is-ancestor', tagSha, revision]) === 0) {
      // Only :latest moves with dev, so only its reason blames dev.
      const after =
        `the published image was built from ${revision}, which comes AFTER the release ` +
        `commit ${tagSha} (it descends from it), not before`
      return {
        ok: false,
        reason:
          tag === 'latest'
            ? `${after} -- :latest moved ahead on dev after ` +
              `${tagSha} was already tagged. This is not a stale image and merging will not help, since ` +
              `${tagSha} is fixed history now. Either cut the release tag from a commit that already ` +
              `includes ${revision}, or wait for a fresh dev-proven build whose revision predates ${tagSha}.`
            : `${after}, so it can contain changes the release commit does not have.`,
      }
    }
    return {
      ok: false,
      reason:
        `the published image was built from ${revision}, which shares no ancestry with the ` +
        `release commit ${tagSha} -- they are on diverged history, so neither descends from the other. ` +
        `Re-publish the image from a commit that is actually an ancestor of ${tagSha}, then cut the ` +
        `release tag again.`,
    }
  }

  if (sourcePaths) {
    // A failing `git diff` is a git error, not a verdict on the candidate, so
    // it fails the image with a message this script chose rather than an
    // uncaught stack trace.
    const diffArgs = ['diff', '--name-only', revision, tagSha, '--', ...sourcePaths.split(',')]
    const diff = run('git', diffArgs)
    if (diff.status !== 0) {
      throw new ImageFailure(
        `could not diff ${revision}..${tagSha} for source changes: ${failed('git', diffArgs, diff)}`
      )
    }
    const changed = diff.stdout.trim()
    if (changed) {
      // Pushing to dev refreshes :latest, never any other tag.
      const advice =
        tag === 'latest' ? ' Push to dev and let build-publish run before tagging.' : ''
      return {
        ok: false,
        reason: `source changed after the published image (${revision}).${advice}\nchanged:\n${changed}`,
      }
    }
  }

  return { ok: true, digest }
}

// The release candidates for the release commit tagSha, best first. A
// generator, so each candidate is produced only after every earlier one was
// rejected: the previous release is looked up only once :latest has failed.
function* candidates(tagSha) {
  yield { tag: 'latest' }
  const prev = previousRelease(tagSha)
  if (prev !== null) yield { tag: prev }
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exitCode = 1
}

function main() {
  const image = argValue('--image')
  const sourcePaths = argValue('--source-paths')
  const tagSha = argValue('--tag-sha')

  if (!image || !tagSha) return fail('--image and --tag-sha are required')

  const rejected = []
  // The candidate being checked, so an error names it. null between
  // candidates, when the error comes from producing the next one.
  let checking = null
  try {
    for (const candidate of candidates(tagSha)) {
      checking = candidate.tag
      const result = evaluateCandidate({ ...candidate, image, tagSha, sourcePaths })
      if (result.ok) {
        process.stdout.write(`${result.digest}\t${candidate.tag}\n`)
        return
      }
      // Continuation lines (the changed-file list) stay indented under their
      // candidate.
      rejected.push(`  ${candidate.tag}: ${result.reason.replaceAll('\n', '\n    ')}`)
      checking = null
    }
  } catch (error) {
    if (!(error instanceof ImageFailure)) throw error
    return fail(
      [
        `${image}: ${checking === null ? '' : `${checking}: `}${error.message}`,
        ...(rejected.length > 0 ? ['Candidates rejected before this error:', ...rejected] : []),
      ].join('\n')
    )
  }

  fail(
    [
      `${image}: no release candidate passed for ${tagSha}:`,
      ...rejected,
      `To release ${image}, build it at ${tagSha} on main with build-publish.yml ` +
        `hotfix_images=${image}, or for a dev→main release let dev's build-publish run first.`,
    ].join('\n')
  )
}

main()
