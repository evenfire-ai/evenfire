#!/bin/sh
# egress-proxy-template-check-table: the R1-M2 context x value table for
# egress-proxy-template-check (#1240).
#
# Run inside the egress proxy image with --network none, with the check program
# as the only argument:
#
#   sh table.sh /usr/local/bin/egress-proxy-template-check
#
# Each row renders the reference where HCC renders it (right before the closing
# quote of an authHeaders value, or right before the `;` of the baseUrl query),
# runs the check with V=<value>, substitutes the template with envsubst, parses
# it with `nginx -t`, and when that passes starts NGINX on 127.0.0.1 and fetches
# the probe path. The verdict is compared with the reviewed table below.
#
# `intact` means the response equals the value. In the unquoted row a backend
# location echoes <$args>, which must equal <k=VALUE>.
#
# One TSV row per case, then the summary line:
#
#   context	label	check	nginx-t	intact	class	expected	flags
#   ROWS=<n> MISMATCH=<m> BAD=<b>
#
# MISMATCH: the check's verdict differs from the reviewed one.
# BAD: the check accepted a value that `nginx -t` rejects or that does not
# arrive intact.
# A flagged row (flags other than `-`) is also echoed before the summary as
#   FLAGGED <context> <label> <flags>
# tab-separated, for at most 20 rows plus one count line for the rest, so a
# failure names the rows to inspect without unbounded output.
# class: ok (ACCEPT and intact), strict (REJECT and NGINX fails or the value
# changes), class (REJECT although the syntax and the value are intact, outside
# the unquoted value class), conserv (REJECT although the syntax and the value
# are intact: context rule), bad (ACCEPT but not intact).
#
# Exit: 0 only when ROWS=170, MISMATCH=0 and BAD=0.
set -u
CHECK="${1:?usage: table.sh <egress-proxy-template-check>}"
W=/tmp/egress-proxy-template-check-table
EXPECTED_ROWS=170

for tool in awk envsubst nginx wget; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: $tool is required" >&2; exit 1; }
done
rm -rf "$W"
mkdir -p "$W/c"

# ── Table ────────────────────────────────────────────────────────────────────
# Each reference sits where HCC renders it: right before the closing quote
# (authHeaders) or right before the `;` (the baseUrl query in proxy_pass).
# shellcheck disable=SC2016 # the templates are literal text: envsubst expands ${V}.
render() { # context -> template on stdout (V is the variable under test)
  case "$1" in
    quoted)   printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { default_type text/plain; return 200 "${V}"; } }' ;;
    unquoted) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { proxy_pass http://127.0.0.1:8081/echo?k=${V}; } }' ;;
    argstart) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { default_type text/plain; return 200 ${V}; } }' ;;
    squote)   printf '%s\n' "server { listen 127.0.0.1:8080; location = /p { default_type text/plain; return 200 '\${V}'; } }" ;;
    comment)  printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { default_type text/plain; # note ${V}' '  return 200 "ok"; } }' ;;
    escaped)  printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { default_type text/plain; return 200 x\${V}; } }' ;;
    bare)     printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { default_type text/plain; return 200 "$V"; } }' ;;
    # The template references $host, which is not in the environment, so only
    # the "an unset name is skipped" rule can accept it; NGINX resolves $host.
    undef-argstart)     printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { default_type text/plain; return 200 $host; } }' ;;
    # The reference is the whole first line, with no space between # and ${V}:
    # a comment starts only at a token start, so the per-file reset decides.
    first-line-comment) printf '%s\n' '#${V}' 'server { listen 127.0.0.1:8080; location = /p { default_type text/plain; return 200 "ok"; } }' ;;
  esac
}

# Body NGINX must serve when the value stayed one literal.
expected_body() {
  case "$1" in
    quoted|squote|bare|argstart) printf '%s' "$2" ;;
    unquoted) printf '<k=%s>' "$2" ;;
    comment)  printf 'ok' ;;
    escaped)  printf 'x\\%s' "$2" ;;
    undef-argstart)     printf '%s' '127.0.0.1' ;;
    first-line-comment) printf '%s' 'ok' ;;
  esac
}

# The reviewed verdicts: the R1-M1 prototype's verdict column
# (1240-scratch/table-tc-r1m1.tsv) for the 168 context rows, plus the two
# special rows. The ACCEPT rows are listed; every other row is a REJECT.
ACCEPT_ROWS="
quoted:alnum quoted:unreserved quoted:empty quoted:space quoted:squote quoted:semicolon
quoted:lbrace quoted:rbrace quoted:hash quoted:plus quoted:amp quoted:question quoted:equals
quoted:slash quoted:colon quoted:pct-ok quoted:pct-bad quoted:pct-short unquoted:alnum
unquoted:unreserved unquoted:empty unquoted:pct-ok bare:alnum bare:unreserved bare:empty
bare:space bare:squote bare:semicolon bare:lbrace bare:rbrace bare:hash bare:plus bare:amp
bare:question bare:equals bare:slash bare:colon bare:pct-ok bare:pct-bad bare:pct-short
undef-argstart:undef-argstart
"
expected_verdict() { # context label -> ACCEPT|REJECT
  for key in $ACCEPT_ROWS; do
    if [ "$key" = "$1:$2" ]; then
      printf '%s\n' ACCEPT
      return
    fi
  done
  printf '%s\n' REJECT
}

# The value class computed independently of the check program, used only to
# label a REJECT: the check itself never calls this.
in_class() {
  if ! printf '%s' "$1" | sed 's/%[0-9A-Fa-f][0-9A-Fa-f]//g' | grep -qE '^[A-Za-z0-9._~-]*$'; then
    return 1
  fi
  [ "$(printf '%s' "$1" | wc -l)" -eq 0 ]
}
# ── End table ────────────────────────────────────────────────────────────────

run_case() {
  ctx="$1" label="$2" value="$3"
  rm -rf "$W/c"
  mkdir -p "$W/c/t" "$W/c/conf.d"
  render "$ctx" >"$W/c/t/default.conf.template"
  if V="$value" awk -f "$CHECK" "$W/c/t/default.conf.template" >/dev/null 2>&1; then
    chk=ACCEPT
  else
    chk=REJECT
  fi
  V="$value" envsubst "\${V} \$V" <"$W/c/t/default.conf.template" >"$W/c/conf.d/default.conf"
  cat >"$W/c/nginx.conf" <<EOF
pid $W/c/nginx.pid;
error_log $W/c/error.log notice;
events {}
http {
  access_log off;
  client_body_temp_path $W/c/cb; proxy_temp_path $W/c/pt; fastcgi_temp_path $W/c/ft; uwsgi_temp_path $W/c/ut; scgi_temp_path $W/c/st;
  server { listen 127.0.0.1:8081; location /echo { default_type text/plain; return 200 "<\$args>"; } }
  include $W/c/conf.d/*.conf;
}
EOF
  if nginx -t -c "$W/c/nginx.conf" >/dev/null 2>&1; then nt=OK; else nt=FAIL; fi
  intact=-
  if [ "$nt" = OK ]; then
    nginx -c "$W/c/nginx.conf" >/dev/null 2>&1
    i=0
    while [ ! -s "$W/c/nginx.pid" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.05; done
    body="$(wget -q -O - http://127.0.0.1:8080/p 2>/dev/null)"
    rc=$?
    nginx -c "$W/c/nginx.conf" -s stop >/dev/null 2>&1
    i=0
    while [ -e "$W/c/nginx.pid" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.05; done
    if [ "$rc" -eq 0 ] && [ "$body" = "$(expected_body "$ctx" "$value")" ]; then
      intact=yes
    else
      intact=no
    fi
  fi
  if [ "$chk" = ACCEPT ]; then
    if [ "$nt" = OK ] && [ "$intact" = yes ]; then verdict=ok; else verdict=bad; fi
  elif [ "$nt" = FAIL ] || [ "$intact" = no ]; then
    verdict=strict
  elif [ "$ctx" = unquoted ] && ! in_class "$value"; then
    verdict=class
  else
    verdict=conserv
  fi
  expected="$(expected_verdict "$ctx" "$label")"
  flags=""
  if [ "$chk" != "$expected" ]; then
    flags=MISMATCH
    mismatches=$((mismatches + 1))
  fi
  if [ "$verdict" = bad ]; then
    if [ -n "$flags" ]; then flags="$flags,BAD"; else flags=BAD; fi
    bads=$((bads + 1))
  fi
  [ -n "$flags" ] || flags=-
  if [ "$flags" != "-" ]; then
    flagged=$((flagged + 1))
    if [ "$flagged" -le "$MAX_FLAGGED" ]; then
      printf 'FLAGGED\t%s\t%s\t%s\n' "$ctx" "$label" "$flags"
    fi
  fi
  rows=$((rows + 1))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ctx" "$label" "$chk" "$nt" "$intact" "$verdict" "$expected" "$flags"
}

rows=0
mismatches=0
bads=0
flagged=0
MAX_FLAGGED=20
TAB="$(printf '\t')"
LF="$(printf 'a\nb')"
# The undef-argstart row depends on this name being absent from the environment.
unset host 2>/dev/null || true

for ctx in quoted unquoted argstart squote comment escaped bare; do
  run_case "$ctx" alnum "Ab0"
  run_case "$ctx" unreserved "a.b_c~d-e"
  run_case "$ctx" empty ""
  run_case "$ctx" tab "a${TAB}b"
  run_case "$ctx" lf "$LF"
  run_case "$ctx" space "a b"
  run_case "$ctx" dquote 'a"b'
  run_case "$ctx" squote "a'b"
  run_case "$ctx" dollar "a\$host"
  run_case "$ctx" backslash-end "a\\"
  run_case "$ctx" backslash-mid 'a\b'
  run_case "$ctx" semicolon 'a;b'
  run_case "$ctx" lbrace 'a{b'
  run_case "$ctx" rbrace 'a}b'
  run_case "$ctx" hash 'a#b'
  run_case "$ctx" plus 'a+b'
  run_case "$ctx" amp 'a&x=1'
  run_case "$ctx" question 'a?b'
  run_case "$ctx" equals 'a=b'
  run_case "$ctx" slash 'a/b'
  run_case "$ctx" colon 'a:b'
  run_case "$ctx" pct-ok 'a%2Bb'
  run_case "$ctx" pct-bad 'a%zzb'
  run_case "$ctx" pct-short 'a%2'
done
run_case undef-argstart undef-argstart "Ab0"
run_case first-line-comment first-line-comment "Ab0"

if [ "$flagged" -gt "$MAX_FLAGGED" ]; then
  printf 'FLAGGED\t-\t-\t%s more row(s) not shown\n' "$((flagged - MAX_FLAGGED))"
fi
printf 'ROWS=%s MISMATCH=%s BAD=%s\n' "$rows" "$mismatches" "$bads"
if [ "$rows" -ne "$EXPECTED_ROWS" ]; then
  echo "FAIL: evaluated $rows rows, expected $EXPECTED_ROWS" >&2
  exit 1
fi
if [ "$mismatches" -ne 0 ]; then
  echo "FAIL: $mismatches row(s) disagree with the reviewed verdicts (FLAGGED rows name them)" >&2
  exit 1
fi
if [ "$bads" -ne 0 ]; then
  echo "FAIL: $bads accepted value(s) did not survive NGINX intact (FLAGGED rows name them)" >&2
  exit 1
fi
exit 0
