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

# extract <variant> <dest-overlay-dir>
extract() {
  ruby -rfileutils -e '
    variant, dest = ARGV[1], ARGV[2]
    text = File.read(ARGV[0])
    n = 0
    text.scan(/<!-- file: (\S+) variants: ([AB ]+) -->\s*\n```ya?ml\n(.*?)```/m) do |path, vs, body|
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
  [ "$v" = A ] && mode=controller || mode=tunnel
  OVERLAY_DIR="$ov" API_IPS='10.96.0.1 198.51.100.10' API_ENDPOINT_PORT=443 \
    DNS_IP=10.96.0.10 STORAGE_CLASS=do-block-storage INGRESS_MODE="$mode" \
    INGRESS_NAMESPACE=traefik \
    INGRESS_POD_LABELS='app.kubernetes.io/name=traefik,app.kubernetes.io/instance=traefik-traefik' \
    bash "$SKILL/scripts/write-network-patches.sh" >/dev/null || { fail "$v: write-network-patches failed"; return 1; }
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
guide_gate A
guide_gate B

if [ "$fails" -ne 0 ]; then
  echo "test-doks-overlay-contract: $fails failure(s)" >&2
  exit 1
fi
echo "test-doks-overlay-contract: OK"
