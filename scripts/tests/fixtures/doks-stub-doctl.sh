#!/usr/bin/env bash
# Stub doctl for scripts/tests/test-doks-discover.sh. Logs argv to
# $STUB_DIR/doctl.log and serves JSON from $STUB_ACCOUNT_JSON / $STUB_CLUSTER_JSON.
set -uo pipefail
: "${STUB_DIR:?set STUB_DIR}"
printf '%s\n' "$*" >>"$STUB_DIR/doctl.log"
case " $* " in
  *" account get "*) cat "${STUB_ACCOUNT_JSON:?}" ;;
  *" kubernetes cluster get "*) cat "${STUB_CLUSTER_JSON:?}" ;;
  *) echo "doks-stub-doctl: unexpected call: $*" >&2; exit 99 ;;
esac
