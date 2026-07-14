#!/usr/bin/env bash
# Post-deploy behavioral gate for the Cloudflare Tunnel ingress.
# Curls each public hostname and asserts edge behavior. Run ONLY after the
# tunnel is up, DNS is routed, and the Cloudflare dashboard config (Access
# apps, WAF) is in place. NOT a CI test — needs live public ingress.
#
# Usage: scripts/e2e/e2e-cluster-ingress-gate.sh [dev|prod]   (default: dev)
set -euo pipefail

ENV="${1:-dev}"
case "$ENV" in
  dev)  S="example.com" ;;
  prod) S="example.com" ;;
  *) echo "usage: $0 [dev|prod]" >&2; exit 2 ;;
esac

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $1"; fail=$((fail + 1)); }

# status <url> -> HTTP status code; prints 000 and never errors on a dead host.
status()  { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" || true; }
# headers <url> -> raw response headers; never errors.
headers() { curl -s -D - -o /dev/null --max-time 15 "$1" || true; }
# is_access_redirect <header-block> -> true if it is a Cloudflare Access 302.
is_access_redirect() { echo "$1" | grep -qiE '^location:.*cloudflareaccess\.com'; }

echo "== cluster-ingress gate ($ENV) =="

# 1. API + RPC health endpoints are public 200.
for h in "api.$S" "rpc.$S"; do
  c=$(status "https://$h/health")
  if [ "$c" = "200" ]; then ok "$h/health -> 200"; else bad "$h/health -> $c (want 200)"; fi
done

# 2. Access-gated UI hostnames 302 to the Cloudflare Access login w/o a cookie.
access_hosts=("app.$S")
if [ "$ENV" = "dev" ]; then access_hosts+=("profile.$S"); fi
for h in "${access_hosts[@]}"; do
  if is_access_redirect "$(headers "https://$h/")"; then
    ok "$h -> Access login redirect"
  else
    bad "$h -> no Access redirect (expected Cloudflare Access 302)"
  fi
done

# 3. prod profile-ui stays public: not Access-gated AND a real 200.
if [ "$ENV" = "prod" ]; then
  if is_access_redirect "$(headers "https://profile.$S/")"; then
    bad "profile.$S -> Access redirect (must stay public)"
  else
    ok "profile.$S -> not Access-gated"
  fi
  c=$(status "https://profile.$S/")
  if [ "$c" = "200" ]; then ok "profile.$S -> 200"; else bad "profile.$S -> $c (want 200)"; fi
fi

# 4. API/RPC are NOT Access-gated AND return a real application status.
for h in "api.$S" "rpc.$S"; do
  if is_access_redirect "$(headers "https://$h/")"; then
    bad "$h -> Access redirect (must rely on app-layer auth)"
  else
    ok "$h -> not Access-gated"
  fi
  c=$(status "https://$h/")
  # 404 is a valid "service responded" signal — neither service has a
  # `GET /` handler today (Express default-404 ≠ tunnel failure). 5xx/000
  # remains a fail (real transport or server error).
  case "$c" in
    200|401|403|404) ok "$h -> application status $c" ;;
    *) bad "$h -> $c (want an app status 200/401/403/404, not 5xx/000)" ;;
  esac
done

# 5. Cookie scoping (MEDIUM-2). Only checkable where the origin actually
# responds: Access-gated hosts 302 to Cloudflare before the app runs, so they
# emit no app cookie. The post-login cookie check on the gated hosts is a
# runbook drill (see your private deployment runbook, cloudflare-ingress §10 steps 4-6). Here: prod
# profile-ui only (the one genuinely public origin).
if [ "$ENV" = "prod" ]; then
  if headers "https://profile.$S/" | grep -i '^set-cookie:' \
       | grep -qiE 'domain=\.?evenfire\.ai'; then
    bad "profile.$S -> Set-Cookie has parent-domain Domain= (must be host-scoped)"
  else
    ok "profile.$S -> cookies host-scoped (or none)"
  fi
else
  echo "  SKIP: cookie-scoping has no public origin on dev — see runbook post-login drill"
fi

# 6. CORS (MEDIUM-5): preflight from a trusted origin is reflected; evil is not.
trusted="https://profile.$S"
acao() {  # acao <origin> -> the Access-Control-Allow-Origin value (may be empty)
  curl -s -D - -o /dev/null --max-time 15 -X OPTIONS \
    -H "Origin: $1" -H 'Access-Control-Request-Method: GET' \
    "https://api.$S/health" 2>/dev/null \
    | tr -d '\r' \
    | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}' || true
}
got=$(acao "$trusted")
if [ "$got" = "$trusted" ]; then
  ok "CORS reflects $trusted"
else
  bad "CORS for $trusted -> '$got' (want '$trusted')"
fi
got=$(acao "https://evil.example.com")
if [ -z "$got" ]; then
  ok "CORS rejects evil.example.com"
else
  bad "CORS for evil.example.com -> '$got' (want none)"
fi

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
