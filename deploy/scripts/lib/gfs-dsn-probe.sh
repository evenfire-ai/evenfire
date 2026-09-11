#!/usr/bin/env bash
# Validate a persisted GFSC connection URI from stdin. Connection material
# never enters argv or the environment.

gfs_dsn_validate() {
  local expected_role="$1" expected_host="$2" expected_port="$3" expected_db="$4"
  python3 -c '
import sys
import unicodedata
import re
from urllib.parse import unquote, urlsplit

expected_role, expected_host, expected_port, expected_db = sys.argv[1:]
try:
    raw = sys.stdin.read()
    if not raw or "\\" in raw or any(ch.isspace() or unicodedata.category(ch).startswith("C") for ch in raw):
        raise ValueError
    parsed = urlsplit(raw)
    _userinfo, separator, _host = parsed.netloc.rpartition("@")
    password = unquote(parsed.password or "")
    valid = (
        parsed.scheme in ("postgres", "postgresql")
        and bool(separator)
        and unquote(parsed.username or "") == expected_role
        and bool(re.fullmatch(r"[0-9a-f]{48}", password))
        and parsed.hostname == expected_host
        and parsed.port == int(expected_port)
        and unquote(parsed.path.removeprefix("/")) == expected_db
        and not parsed.query
        and not parsed.fragment
    )
except (ValueError, UnicodeError):
    valid = False
if not valid:
    raise SystemExit(1)
' "$expected_role" "$expected_host" "$expected_port" "$expected_db"
}

gfs_dsn_password() {
  python3 -c '
import sys
import re
from urllib.parse import unquote, urlsplit
value = unquote(urlsplit(sys.stdin.read()).password or "")
if not re.fullmatch(r"[0-9a-f]{48}", value):
    raise SystemExit(1)
print(value, end="")
'
}

gfs_dsn_authenticates_as() {
  local dsn="$1" expected_role="$2" actual rc
  # Explicitly select the application container.  `kubectl exec` can otherwise
  # resolve a deployment's default container inconsistently while a rollout is
  # replacing its pod, turning an authentication rejection into an
  # "unavailable" probe and preventing safe NOLOGIN recovery.
  local probe_container="${PG_PROBE_CONTAINER:-control-api}"
  printf '%s' "$dsn" | gfs_dsn_validate \
    "$expected_role" "$PG_HOST" "$PG_PORT" "$PG_DB" || return 1

  # Authenticate through the same Service DNS and SCRAM path used by GFSC.
  # The connection string stays on stdin; the fixed program emits only the
  # authenticated role and intentionally suppresses connection error details.
  actual="$(printf '%s' "$dsn" | kc -n "$PG_NS" exec -i "$PG_PROBE_DEPLOY" -c "$probe_container" -- node -e '
const { Client } = require("pg");
let raw = "";
process.stdin.on("data", chunk => { raw += chunk });
process.stdin.on("end", async () => {
  const client = new Client({ connectionString: raw, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query("SELECT current_user");
    process.stdout.write(result.rows[0].current_user);
  } catch (error) {
    if (error && (error.code === "28P01" || error.code === "28000")) {
      process.stdout.write("GFS_DSN_AUTH_REJECTED");
      process.exitCode = 41;
    } else {
      process.exitCode = 42;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
});' 2>/dev/null)" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    # A fixed marker plus the remote process exit code identifies a completed
    # authentication rejection. Kubernetes API, exec-stream, pod readiness,
    # and transport failures are unavailable, never bad credentials.
    if [ "$rc" -eq 41 ] && [ "$actual" = GFS_DSN_AUTH_REJECTED ]; then
      return 1
    fi
    return 2
  fi
  actual="${actual//[[:space:]]/}"
  [ "$actual" = "$expected_role" ]
}
