#!/bin/sh
# egress-proxy-template-check-table: the shared corpus, against the image's own
# egress-proxy-template-check and real NGINX.
#
# Run inside the egress proxy image with --network none, after rendering the two
# HCC templates on the host:
#
#   sh table.sh <check> <corpus.tsv> <hcc-query-template> <hcc-quoted-template>
#
# Each corpus row renders the reference where HCC renders it, runs the image's
# check with V=<value>, substitutes the template with envsubst, parses it with
# `nginx -t`, and when that passes starts NGINX on 127.0.0.1 and fetches the
# probe path. Values are decoded here, not through Docker's JSON environment,
# which replaces invalid UTF-8.
#
# `query` and `quoted` rows are also checked on the real HCC-rendered templates
# (baseUrl query and authHeaders value) and compared with the synthetic verdict:
# EQUIV counts those rows, DIFF the disagreements.
#
# Output: one nine-column TSV row per corpus row, then the summary line
#
#   context label check nginx-t intact expected flags hcc-check semantic
#
# flags: - or MISMATCH (the check's verdict differs from the reviewed one) and
# BAD (the check accepted a value NGINX rejects, a value that does not arrive
# intact, or a query value a form decoder changes). semantic is `same`,
# `changed` or `-`: the first echoed parameter, form-decoded, must equal the
# percent-decoded original value. A row with check ACCEPT and semantic=changed
# is BAD, so widening the class to raw `+` fails even if the expected verdicts
# were edited with it.
#
# Exit: 0 only when ROWS equals the corpus data lines and MISMATCH, BAD and DIFF
# are all 0; 1 on a failed assertion; 2 on an infrastructure problem (missing
# tool, malformed corpus, NGINX that will not start or stop).
set -u
CHECK="${1:?check path required}"
CORPUS="${2:?corpus path required}"
HCC_QUERY="${3:?rendered query template required}"
HCC_QUOTED="${4:?rendered header template required}"
W=/tmp/egress-proxy-template-check-table

for tool in awk envsubst nginx wget; do
  command -v "$tool" >/dev/null 2>&1 || { echo "INFRA: missing $tool" >&2; exit 2; }
done
rm -rf "$W"
mkdir -p "$W/c"
# Reject malformed data before treating its value field as a printf format.
awk -F '\t' '
  /^#/ || /^$/ { next }
  NF != 4 || $1 !~ /^[a-z-]+$/ || $2 !~ /^[a-z0-9-]+$/ ||
    $4 !~ /^(ACCEPT|REJECT)$/ { exit 2 }
  {
    s = $3
    while (length(s)) {
      if (s ~ /^[A-Za-z0-9]/) s = substr(s, 2)
      else if (s ~ /^\\[0-7][0-7][0-7]/ && substr(s, 1, 4) != "\\000") s = substr(s, 5)
      else exit 2
    }
    print $1 "|" $2 "|" $3 "|" $4
    n++
  }
  END { if (!n) exit 2 }
' "$CORPUS" >"$W/rows" || { echo 'INFRA: invalid or empty corpus' >&2; exit 2; }
EXPECTED_ROWS="$(wc -l <"$W/rows" | tr -d ' ')"

# shellcheck disable=SC2016 # These are NGINX templates, not shell expansions.
render() {
  case "$1" in
    quoted) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 "${V}"; } }' ;;
    query) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { proxy_pass http://127.0.0.1:8081/echo?k=${V}; } }' ;;
    unquoted) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 x${V}; } }' ;;
    argstart) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 ${V}; } }' ;;
    squote) printf '%s\n' "server { listen 127.0.0.1:8080; location = /p { return 200 '\${V}'; } }" ;;
    comment) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { # note ${V}' 'return 200 "ok"; } }' ;;
    escaped) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 x\${V}; } }' ;;
    bare) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 "$V"; } }' ;;
    undef-argstart) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 $host; } }' ;;
    first-line-comment) printf '%s\n' '#${V}' 'server { listen 127.0.0.1:8080; location = /p { return 200 "ok"; } }' ;;
    undef-brace-quoted) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 "${HTTP_X_UNDECLARED}"; } }' ;;
    undef-brace-query) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { proxy_pass http://127.0.0.1:8081/echo?k=${HTTP_X_UNDECLARED}; } }' ;;
    query-first-char) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 ?${V}; } }' ;;
    query-second-arg) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { add_header X?Y x${V}; return 200 ok; } }' ;;
    query-escaped-qmark) printf '%s\n' 'server { listen 127.0.0.1:8080; location = /p { return 200 x\?${V}; } }' ;;
    query-escape-start) printf '%s\n' 'log_format t a?b \x${V};' 'server { listen 127.0.0.1:8080; location = /p { return 200 ok; } }' ;;
    *) echo "INFRA: unknown context $1" >&2; return 2 ;;
  esac
}

expected_body() {
  case "$1" in
    quoted|squote|bare|argstart) printf '%s' "$2" ;;
    query) printf '<k=%s>' "$2" ;;
    unquoted) printf 'x%s' "$2" ;;
    comment|first-line-comment|query-second-arg|query-escape-start) printf ok ;;
    escaped) printf 'x\\%s' "$2" ;;
    undef-argstart) printf 127.0.0.1 ;;
    undef-brace-quoted) printf '' ;;
    undef-brace-query) printf '<k=>' ;;
    query-first-char) printf '?%s' "$2" ;;
    query-escaped-qmark) printf 'x?%s' "$2" ;;
  esac
}

# Decode one percent-encoded value once. The served query uses form semantics;
# the original uses percent decoding without converting + to a space.
semantic_query() {
  VALUE="$1" SERVED="$2" awk '
    function decode(s, form, out, i, c, h, a, b) {
      h="0123456789ABCDEF"; out=""
      for (i=1; i<=length(s); i++) {
        c=substr(s,i,1)
        if (form && c=="+") c=" "
        else if (c=="%" && i+2<=length(s)) {
          a=index(h,toupper(substr(s,i+1,1))); b=index(h,toupper(substr(s,i+2,1)))
          if (a && b) { c=sprintf("%c", (a-1)*16+b-1); i+=2 }
        }
        out=out c
      }
      return out
    }
    BEGIN {
      s=ENVIRON["SERVED"]; sub(/^<k=/,"",s); sub(/>$/,"",s); sub(/&.*/,"",s)
      print decode(s,1)==decode(ENVIRON["VALUE"],0) ? "same" : "changed"
    }'
}

rows=0 mismatches=0 bads=0 equiv=0 diffs=0
unset host HTTP_X_UNDECLARED 2>/dev/null || true
while IFS='|' read -r ctx label field expected; do
  # The corpus format was validated above and contains no percent signs.
  # shellcheck disable=SC2059
  value="$(printf "${field}x")"; value="${value%x}"
  hcc_check=-
  rm -rf "$W/c"
  mkdir -p "$W/c/conf.d"
  render "$ctx" >"$W/c/default.conf.template" || exit 2
  if V="$value" awk -f "$CHECK" "$W/c/default.conf.template" >/dev/null 2>&1; then
    chk=ACCEPT
  else
    rc=$?
    [ "$rc" -eq 1 ] || { echo "INFRA: check exited $rc for $ctx/$label" >&2; exit 2; }
    chk=REJECT
  fi
  case "$ctx" in
    query|quoted)
      if [ "$ctx" = query ]; then hcc="$HCC_QUERY"; else hcc="$HCC_QUOTED"; fi
      if V="$value" awk -f "$CHECK" "$hcc" >/dev/null 2>&1; then hcc_check=ACCEPT
      else
        rc=$?
        [ "$rc" -eq 1 ] || { echo "INFRA: renderer check exited $rc" >&2; exit 2; }
        hcc_check=REJECT
      fi
      equiv=$((equiv + 1))
      [ "$hcc_check" = "$chk" ] || diffs=$((diffs + 1))
      ;;
  esac
  # shellcheck disable=SC2016
  V="$value" envsubst '${V} $V' <"$W/c/default.conf.template" >"$W/c/conf.d/default.conf"
  cat >"$W/c/nginx.conf" <<EOF
pid $W/c/nginx.pid;
error_log $W/c/error.log notice;
events {}
http {
  access_log off;
  client_body_temp_path $W/c/cb; proxy_temp_path $W/c/pt; fastcgi_temp_path $W/c/ft; uwsgi_temp_path $W/c/ut; scgi_temp_path $W/c/st;
  server { listen 127.0.0.1:8081; location /echo { return 200 "<\$args>"; } }
  include $W/c/conf.d/*.conf;
}
EOF
  if nginx -t -c "$W/c/nginx.conf" >/dev/null 2>&1; then nt=OK; else nt=FAIL; fi
  intact=- semantic=-
  if [ "$nt" = OK ]; then
    nginx -c "$W/c/nginx.conf" >/dev/null 2>&1 || { echo "INFRA: nginx start $ctx/$label" >&2; exit 2; }
    i=0
    while [ ! -s "$W/c/nginx.pid" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.05; done
    [ -s "$W/c/nginx.pid" ] || { echo "INFRA: nginx pid $ctx/$label" >&2; exit 2; }
    # Sentinel preserves a response ending in LF in command substitution.
    body="$(wget -Y off -q -O - http://127.0.0.1:8080/p 2>/dev/null; rc=$?; printf x; exit "$rc")"; rc=$?
    body="${body%x}"
    nginx -c "$W/c/nginx.conf" -s stop >/dev/null 2>&1 || { echo "INFRA: nginx stop $ctx/$label" >&2; exit 2; }
    i=0
    while [ -e "$W/c/nginx.pid" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.05; done
    [ ! -e "$W/c/nginx.pid" ] || { echo "INFRA: nginx did not stop $ctx/$label" >&2; exit 2; }
    want="$(expected_body "$ctx" "$value"; printf x)"; want="${want%x}"
    if [ "$rc" -eq 0 ] && [ "$body" = "$want" ]; then intact=yes; else intact=no; fi
    if [ "$ctx" = query ] && [ "$rc" -eq 0 ]; then semantic="$(semantic_query "$value" "$body")"; fi
  fi
  flags=-
  if [ "$chk" != "$expected" ]; then flags=MISMATCH; mismatches=$((mismatches + 1)); fi
  if [ "$chk" = ACCEPT ] && { [ "$nt" != OK ] || [ "$intact" != yes ] || [ "$semantic" = changed ]; }; then
    [ "$flags" = - ] && flags=BAD || flags="$flags,BAD"
    bads=$((bads + 1))
  fi
  rows=$((rows + 1))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ctx" "$label" "$chk" "$nt" "$intact" "$expected" "$flags" "$hcc_check" "$semantic"
done <"$W/rows"
printf 'ROWS=%s MISMATCH=%s BAD=%s EQUIV=%s DIFF=%s\n' "$rows" "$mismatches" "$bads" "$equiv" "$diffs"
[ "$rows" -eq "$EXPECTED_ROWS" ] && [ "$mismatches" -eq 0 ] && [ "$bads" -eq 0 ] && [ "$diffs" -eq 0 ]
