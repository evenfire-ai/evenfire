#!/usr/bin/env bash
# Integrity test for the DOKS how-to and the evenfire-digitalocean-doks skill:
# relative links and anchors resolve, the skill's phase numbers exist in the
# guide, the validated release is written once, idempotence guards are present,
# index pointers exist, and every DOKS helper test runs in CI.
set -uo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
GUIDE="docs/deploy/digitalocean-doks-agent-guide.md"
SKILL_DIR=".agents/skills/evenfire-digitalocean-doks"
fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }
cd "$ROOT_DIR" || exit 1

docs=("$GUIDE" "$SKILL_DIR/SKILL.md" "$SKILL_DIR"/references/*.md ".cursor/skills/evenfire-digitalocean-doks/SKILL.md")
for f in "${docs[@]}"; do [ -f "$f" ] || fail "missing $f"; done

# Relative links and anchors (GitHub heading slugs).
ruby -e '
  def slug(h)
    h.downcase.gsub(/`/, "").gsub(/[^a-z0-9 _-]/, "").tr(" ", "-")
  end
  def anchors(file)
    File.read(file).scan(/^#+ (.+)$/).flatten.map { |h| slug(h.strip) }
  end
  bad = []
  ARGV.each do |f|
    next unless File.exist?(f)
    File.read(f).scan(/\]\(([^)\s]+)\)/).flatten.each do |link|
      next if link.start_with?("http://", "https://", "mailto:")
      path, anchor = link.split("#", 2)
      target = path.empty? ? f : File.expand_path(path, File.dirname(f))
      unless File.exist?(target)
        bad << "#{f}: broken link #{link}"
        next
      end
      if anchor && File.file?(target) && target.end_with?(".md") && !anchors(target).include?(anchor)
        bad << "#{f}: missing anchor #{link}"
      end
    end
  end
  puts bad
  exit(bad.empty? ? 0 : 1)
' "${docs[@]}" >"/tmp/doks-links.$$" 2>&1 || fail "links: $(cat "/tmp/doks-links.$$")"
rm -f "/tmp/doks-links.$$"

# Every phase the skill names exists as a guide heading.
ruby -e '
  guide = File.read(ARGV[0])
  have = guide.scan(/^## Phase ([0-9.]+)/).flatten + guide.scan(/^### ([0-9]+\.[0-9]+) /).flatten
  skill = File.read(ARGV[1])
  want = skill.scan(/\bPhase ([0-9]+(?:\.[0-9]+)?)\b/).flatten + skill.scan(/\[([0-9]+\.[0-9]+)(?:[,\]])/).flatten
  missing = (want.uniq - have).sort
  abort "skill names phases the guide lacks: #{missing.join(", ")}" unless missing.empty?
  abort "skill names no phases" if want.empty?
' "$GUIDE" "$SKILL_DIR/SKILL.md" 2>/dev/null || fail "SKILL.md phase numbers do not match the guide headings"

n="$(cat "$GUIDE" "$SKILL_DIR"/SKILL.md "$SKILL_DIR"/references/*.md | grep -c "VALIDATED_RELEASE='v0.10.0'")"
[ "$n" -eq 1 ] || fail "VALIDATED_RELEASE='v0.10.0' appears $n times, want 1"
grep -rn 'v0\.8\.0' "$GUIDE" "$SKILL_DIR" && fail "stale v0.8.0 reference"

grep -q 'control-api-secrets exists: SKIP' "$GUIDE" || fail "guide lacks the gen-jwt-keys skip guard"
grep -q 'control-postgres-data exists: SKIP' "$GUIDE" || fail "guide lacks the Postgres password skip guard"
grep -nE 'kubectl[^`]*delete[^`]*(cnp|ciliumnetworkpolic)' "$GUIDE" && fail "guide deletes CiliumNetworkPolicies"
grep -nE '^[[:space:]]*doctl([[:space:]]+[^[:space:]]+)*[[:space:]]+auth[[:space:]]+switch' "$GUIDE" "$SKILL_DIR"/*.md "$SKILL_DIR"/references/*.md \
  && fail "a doctl auth switch command is present"

# The guide's Phase 0.1 probe block must stop when a probe fails (no masked exit code).
probe_block="$(ruby -e '
  b = File.read(ARGV[0]).scan(/```bash\n(.*?)```/m).flatten.find { |x| x.include?("api-egress-probe.sh") && x.include?("np-deny-probe.sh") }
  abort "no Phase 0.1 probe block" unless b
  puts b.lines.reject { |l| l.include?(".evenfire-doks/env.sh") }.join' "$GUIDE")" || fail "cannot extract the Phase 0.1 block"
fake="$(mktemp -d)"
for rcs in "0 1" "0 2" "1 0"; do
  set -- $rcs
  printf '#!/usr/bin/env bash\nexit %s\n' "$1" >"$fake/np-deny-probe.sh"
  printf '#!/usr/bin/env bash\necho API_EGRESS_PATH=none\nexit %s\n' "$2" >"$fake/api-egress-probe.sh"
  if (env SKILL_SCRIPTS="$fake" WORK="$fake" CONTEXT=x bash -c "$probe_block") >/dev/null 2>&1; then
    fail "Phase 0.1 block continued with np-deny exit $1 / api-egress exit $2"
  fi
done
printf '#!/usr/bin/env bash\nexit 0\n' >"$fake/np-deny-probe.sh"
printf '#!/usr/bin/env bash\necho API_EGRESS_PATH=cnp\nexit 0\n' >"$fake/api-egress-probe.sh"
(env SKILL_SCRIPTS="$fake" WORK="$fake" CONTEXT=x bash -c "$probe_block") >/dev/null 2>&1 \
  || fail "Phase 0.1 block failed although both probes passed"
grep -qx 'API_EGRESS_PATH=cnp' "$fake/api-egress.env" 2>/dev/null || fail "Phase 0.1 block does not record api-egress.env"
rm -rf "$fake"

for f in AGENTS.md CLAUDE.md docs/README.md docs/llms.txt docs/deploy/production.md; do
  grep -q 'digitalocean-doks' "$f" || fail "$f has no pointer to the DOKS how-to"
done

for t in scripts/tests/test-doks-*.sh; do
  grep -q "bash $t" .github/workflows/ci-public.yml || fail "CI does not run $t"
done

if [ "$fails" -ne 0 ]; then
  echo "test-doks-docs-links: $fails failure(s)" >&2
  exit 1
fi
echo "test-doks-docs-links: OK"
