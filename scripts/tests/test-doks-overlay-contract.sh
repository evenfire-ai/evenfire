#!/usr/bin/env bash
# Renders the customer overlay that
# .agents/skills/evenfire-digitalocean-doks/references/overlay-contract.md
# specifies, for both ingress variants, against the validated release tag, and
# runs the same gates the guide's Phase 4 runs. Each file block in the contract
# is preceded by an HTML comment: <!-- file: <path> variants: A B -->.
set -uo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL="${ROOT_DIR}/.agents/skills/evenfire-digitalocean-doks"
CONTRACT="${SKILL}/references/overlay-contract.md"
GUIDE="${ROOT_DIR}/docs/deploy/digitalocean-doks-agent-guide.md"
RELEASE="v0.10.0"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }

[ -f "$CONTRACT" ] || { echo "FAIL: $CONTRACT missing" >&2; exit 1; }
command -v kubectl >/dev/null || { echo "FAIL: kubectl is required (kubectl kustomize)" >&2; exit 1; }
if ! git -C "$ROOT_DIR" rev-parse -q --verify "refs/tags/$RELEASE" >/dev/null; then
  git -C "$ROOT_DIR" fetch -q --depth 1 origin "refs/tags/$RELEASE:refs/tags/$RELEASE" \
    || { echo "FAIL: release tag $RELEASE is not available" >&2; exit 1; }
fi

# guide_block <marker>: print the guide's first bash block containing <marker>,
# without the env-file line (the test provides the environment).
guide_block() {
  ruby -e '
    blocks = File.read(ARGV[0]).scan(/```bash\n(.*?)```/m).flatten
    b = blocks.find { |x| x.include?(ARGV[1]) } or abort "no guide block containing #{ARGV[1]}"
    puts b.lines.reject { |l| l.include?(".evenfire-doks/env.sh") }.join
  ' "$GUIDE" "$1"
}

# discovery.env from the real doks-discover.sh against stub doctl/kubectl
FIX="${ROOT_DIR}/scripts/tests/fixtures"
mkdir -p "$work/disc"
printf '{"team":{"name":"Example Team"},"status":"active"}' >"$work/disc/account.json"
printf '[{"id":"c-1","version":"1.36.3-do.5","ha":true,"cluster_subnet":"10.240.0.0/16","service_subnet":"10.96.0.0/19","status":{"state":"running"}}]' >"$work/disc/cluster.json"
env STUB_DIR="$work/disc" STUB_ACCOUNT_JSON="$work/disc/account.json" STUB_CLUSTER_JSON="$work/disc/cluster.json" \
  DOCTL="$FIX/doks-stub-doctl.sh" KUBECTL="$FIX/doks-stub-kubectl-discover.sh" \
  DOCTL_CONTEXT=t CLUSTER_NAME=c CONTEXT=do-fra1-c \
  bash "$SKILL/scripts/doks-discover.sh" >"$work/discovery.env" 2>"$work/disc/err" \
  || { echo "FAIL: doks-discover.sh failed: $(cat "$work/disc/err")" >&2; exit 1; }

# extract <variant> <dest-overlay-dir>
extract() {
  ruby -rfileutils -e '
    variant, dest = ARGV[1], ARGV[2]
    text = File.read(ARGV[0])
    n = 0
    text.scan(/<!-- file: (\S+) variants: ([ABC ]+) -->\s*\n```ya?ml\n(.*?)```/m) do |path, vs, body|
      next unless vs.split.include?(variant)
      abort "unsafe path #{path}" if path.start_with?("/") || path.include?("..")
      subs = { "<domain>" => "example.test", "<RELEASE_TAG>" => "v0.10.0",
               "<STORAGE_CLASS>" => "do-block-storage", "<GFS_SIZE>" => "100Gi",
               "<TUNNEL_ID>" => "00000000-0000-0000-0000-000000000000",
               "<LLM_PROVIDER>" => "openai", "<LLM_MODEL>" => "gpt-5.4-mini" }
      subs.each { |k, val| body = body.gsub(k, val) }
      if (left = body[/<[A-Za-z_]+>/])
        abort "unsubstituted placeholder #{left} in #{path}"
      end
      f = File.join(dest, path)
      FileUtils.mkdir_p(File.dirname(f))
      File.write(f, body)
      n += 1
    end
    abort "no file blocks for variant #{variant}" if n.zero?
    puts n
  ' "$CONTRACT" "$1" "$2"
}

render_variant() { # A|B
  local v="$1" tree="$work/tree-$1" mode
  mkdir -p "$tree"
  git -C "$ROOT_DIR" archive "$RELEASE" deploy charts mcp-servers | tar -x -C "$tree"
  local ov="$tree/deploy/overlays/digitalocean-doks"
  mkdir -p "$ov"
  extract "$v" "$ov" >/dev/null || { fail "$v: cannot extract contract blocks"; return 1; }
  case "$v" in A) mode=controller ;; B) mode=tunnel ;; *) mode=internal ;; esac
  # The guide's Phase 4 generator block, fed by real discovery output.
  guide_block 'bash "$SKILL_SCRIPTS/write-network-patches.sh"' \
    | sed -e "s#'<controller|tunnel|internal>'#$mode#" \
          -e "s#'<controller namespace, Variant A>'#traefik#" \
          -e "s#'<key=value,… of the controller pods, Variant A>'#app.kubernetes.io/name=traefik,app.kubernetes.io/instance=traefik-traefik#" \
    >"$work/gen-$v.sh" || { fail "$v: cannot extract the guide generator block"; return 1; }
  grep -q '<' "$work/gen-$v.sh" && { fail "$v: unreplaced placeholder in guide generator block: $(grep '<' "$work/gen-$v.sh")"; return 1; }
  mkdir -p "$work/gw-$v" && cp "$work/discovery.env" "$work/gw-$v/discovery.env"
  (cd "$tree" && env REPO_DIR="$tree" WORK="$work/gw-$v" SKILL_SCRIPTS="$SKILL/scripts" bash "$work/gen-$v.sh") \
    >"$work/gen-$v.log" 2>&1 || { fail "$v: guide generator block failed: $(tail -3 "$work/gen-$v.log")"; return 1; }
  grep -q 'cidr: 10.10.0.2/32' "$ov/patches/k8s-api-ip.yaml" \
    || { fail "$v: discovery API_IPS did not reach the generated patches"; return 1; }
  local r="$work/render-$v.yaml"
  kubectl kustomize "$ov" >"$r" 2>"$work/kz-$v.err" || { fail "$v: kustomize: $(head -3 "$work/kz-$v.err")"; return 1; }

  bash "$tree/deploy/scripts/lint-networkpolicies.sh" --rendered "$r" >"$work/lint-$v.log" 2>&1 \
    || fail "$v: lint-networkpolicies: $(tail -3 "$work/lint-$v.log")"
  RELEASE_TAG="$RELEASE" ruby "$SKILL/scripts/image-gate.rb" <"$r" >"$work/gate-$v.log" 2>&1 \
    || fail "$v: image gate: $(head -3 "$work/gate-$v.log")"
  grep -q '10\.109\.0\.1/32' "$r" && fail "$v: base API placeholder still rendered"
  local leftovers
  leftovers="$(grep -En 'localhost|127\.0\.0\.1|minikube|replace-with-|CLERUM_DEV_MODE|value: warn' "$r" \
    | grep -Ev 'CONTROL_API_GOOGLE_CLIENT_ID: replace-with-|WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN: replace-with-')"
  [ -z "$leftovers" ] || fail "$v: dev leftovers in render: $(printf '%s' "$leftovers" | head -3)"

  ruby -ryaml -e '
    v = ARGV[1]
    docs = YAML.load_stream(File.read(ARGV[0])).compact
    errs = []
    cnps = docs.select { |d| d["kind"] == "CiliumNetworkPolicy" }.map { |d| d.dig("metadata", "namespace") }.sort
    errs << "CNP namespaces #{cnps}" unless cnps == %w[channels control-plane mcp-host mcp-server rpc-proxy sandbox-recipes]
    pol = ->(ns, n) { docs.find { |d| d["kind"] == "NetworkPolicy" && d.dig("metadata", "namespace") == ns && d.dig("metadata", "name") == n } }
    public_ingress = [%w[control-plane control-ui-network], %w[profiles allow-ingress-profiles], %w[rpc-proxy rpc-proxy], %w[webhook-ingress allow-public-ingress-webhook-proxy]]
    public_ingress.each do |ns, n|
      p = pol.(ns, n) or (errs << "missing #{ns}/#{n}"; next)
      froms = Array(p.dig("spec", "ingress")).flat_map { |r| Array(r["from"]) }
      has_ctrl = froms.any? { |f| f.dig("namespaceSelector", "matchLabels", "kubernetes.io/metadata.name") == "traefik" }
      errs << "#{ns}/#{n}: ingress-controller peer #{has_ctrl ? "present" : "absent"} in variant #{v}" if has_ctrl != (v == "A")
      errs << "#{ns}/#{n}: public ingress opened in internal-only variant" if v == "C" && froms.any? { |f| !f.dig("podSelector", "matchLabels", "app").to_s.eql?("cloudflared") }
      errs << "#{ns}/#{n}: ipBlock ingress peer" if froms.any? { |f| f["ipBlock"] }
    end
    cf = docs.find { |d| d["kind"] == "Deployment" && d.dig("metadata", "name") == "cloudflared" }
    errs << "cloudflared rendered=#{!cf.nil?} in variant #{v}" if cf.nil? == (v == "B")
    if v == "B"
      eg = pol.("ingress", "allow-cloudflared-egress")
      world = Array(eg && eg.dig("spec", "egress")).flat_map { |r| Array(r["to"]) }
                .map { |t| t["ipBlock"] }.compact.select { |b| b["cidr"] == "0.0.0.0/0" }
      errs << "allow-cloudflared-egress has no 0.0.0.0/0 rule" if world.empty?
      errs << "allow-cloudflared-egress 0.0.0.0/0 without public-egress exceptions" if world.any? { |b| Array(b["except"]).empty? }
    end
    pvc = docs.find { |d| d["kind"] == "PersistentVolumeClaim" && d.dig("metadata", "name") == "clerum-workflow-output" }
    errs << "clerum-workflow-output access #{pvc && pvc.dig("spec", "accessModes")}" unless pvc && pvc.dig("spec", "accessModes") == ["ReadWriteOnce"]
    pg = docs.find { |d| d["kind"] == "PersistentVolumeClaim" && d.dig("metadata", "name") == "control-postgres-data" }
    errs << "control-postgres-data storageClassName unset" unless pg && pg.dig("spec", "storageClassName")
    cm = docs.find { |d| d["kind"] == "ConfigMap" && d.dig("metadata", "name") == "control-api-config" }
    prefixes = cm && cm.dig("data", "CONTROL_API_ALLOWED_IMAGE_PREFIXES").to_s
    errs << "CONTROL_API_ALLOWED_IMAGE_PREFIXES still allows clerum/" if prefixes.split(",").include?("clerum/")
    rp = docs.find { |d| d["kind"] == "ConfigMap" && d.dig("metadata", "name") == "rpc-proxy-config" }
    errs << "rpc-proxy-config missing" unless rp
    if rp
      bad = rp["data"].keys & %w[RPC_PROXY_DESKTOP_COOKIE_SECRET RPC_PROXY_DESKTOP_API_TOKEN RPC_PROXY_SANDBOX_UI_COOKIE_SECRET]
      errs << "rpc-proxy-config carries secrets #{bad}" unless bad.empty?
    end
    errs << "mcp-host-config missing" unless docs.any? { |d| d["kind"] == "ConfigMap" && d.dig("metadata", "name") == "mcp-host-config" }
    errs << "Gateway API CRDs rendered" if docs.any? { |d| d["kind"] == "CustomResourceDefinition" && d.dig("spec", "group") == "gateway.networking.k8s.io" }
    errs << "a Secret carries data" if docs.any? { |d| d["kind"] == "Secret" && (d["data"].to_h.any? || d["stringData"].to_h.values.any? { |x| x.to_s !~ /\A(replace-with-.*)?\z/ }) }
    if errs.empty? then exit 0 else warn errs.join("\n"); exit 1 end
  ' "$r" "$v" 2>"$work/shape-$v.err" || fail "$v: render shape: $(cat "$work/shape-$v.err")"

  # managed-netpols.rb selects exactly the NetworkPolicies Evenfire's
  # managed-networkpolicy-label-immutability policy refuses to let a non-
  # system:masters admin create.
  ruby "$SKILL/scripts/managed-netpols.rb" <"$r" >"$work/managed-$v.yaml" 2>"$work/managed-$v.err" \
    || fail "$v: managed-netpols.rb failed: $(cat "$work/managed-$v.err")"
  ruby -ryaml -e '
    got = YAML.load_stream(File.read(ARGV[0])).compact
    all = YAML.load_stream(File.read(ARGV[1])).compact
    key = ->(d) { "#{d.dig("metadata","namespace")}/#{d.dig("metadata","name")}" }
    owned = ->(d) { %w[host-context-controller wrc workflow-recipes].include?((d.dig("metadata","labels") || {})["clerum.io/managed-by"]) }
    names = got.map(&key).sort
    expected = all.select { |d| d["kind"] == "NetworkPolicy" && owned.(d) }.map(&key).sort
    # The three a live DOKS apply rejected must be among them.
    live = %w[mcp-server/deny-all-mcp-servers rpc-proxy/allow-ingress-rpc-proxy sandbox-recipes/allow-workflow-approval-gateway-egress-sandbox-recipes]
    abort "missing live-rejected policies #{live - names}" unless (live - names).empty?
    abort "selected #{names.size}, render has #{expected.size} managed NetworkPolicies" unless names == expected
    abort "selected a non-managed object" unless got.all? { |d| d["kind"] == "NetworkPolicy" && owned.(d) }
  ' "$work/managed-$v.yaml" "$r" 2>"$work/managed-chk-$v.err" || fail "$v: $(cat "$work/managed-chk-$v.err")"

  ruby -ryaml -e '
    dir = ARGV[0]
    errs = []
    %w[instances/host.yaml instances/context.yaml instances/globalfilesystem.yaml].each do |f|
      p = File.join(dir, f)
      File.exist?(p) or (errs << "missing #{f}"; next)
      YAML.load_stream(File.read(p)).compact.each { |d| errs << "#{f}: no kind" unless d["kind"] }
    end
    g = YAML.load(File.read(File.join(dir, "instances/globalfilesystem.yaml"))) rescue {}
    sc = g.dig("spec", "storage", "storageClassName")
    errs << "GFS storageClassName #{sc.inspect}" if sc.nil? || sc == "standard-rwo"
    errs << "instances reference telegram" if Dir[File.join(dir, "instances/*.yaml")].any? { |f| File.read(f).include?("telegram") }
    if errs.empty? then exit 0 else warn errs.join("\n"); exit 1 end
  ' "$ov" 2>"$work/inst-$v.err" || fail "$v: instances: $(cat "$work/inst-$v.err")"
}

# The guide's Phase 4 render gate, extracted verbatim (minus the env-file line),
# must pass on each rendered variant.
guide_gate() { # A|B
  local v="$1" tree="$work/tree-$1"
  [ -f "$GUIDE" ] || { fail "guide missing"; return 1; }
  ruby -e '
    blocks = File.read(ARGV[0]).scan(/```bash\n(.*?)```/m).flatten
    gate = blocks.find { |b| b.include?("render gate: OK") } or abort "no render-gate block in guide"
    puts gate.lines.reject { |l| l.include?(".evenfire-doks/env.sh") }.join
  ' "$GUIDE" >"$work/gate-$v.sh" || { fail "$v: cannot extract the guide render gate"; return 1; }
  (cd "$tree" && env REPO_DIR="$tree" WORK="$work/gate-work-$v" RELEASE_TAG="$RELEASE" \
    SKILL_SCRIPTS="$SKILL/scripts" bash -c 'mkdir -p "$WORK"; . "$0"' "$work/gate-$v.sh") \
    >"$work/gate-out-$v.log" 2>&1
  grep -qx 'render gate: OK' "$work/gate-out-$v.log" \
    || fail "$v: guide render gate did not pass: $(tail -3 "$work/gate-out-$v.log")"
}

render_variant A
render_variant B
render_variant C
guide_gate A
guide_gate B
guide_gate C

if [ "$fails" -ne 0 ]; then
  echo "test-doks-overlay-contract: $fails failure(s)" >&2
  exit 1
fi
echo "test-doks-overlay-contract: OK"
