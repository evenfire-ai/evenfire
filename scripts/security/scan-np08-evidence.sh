#!/usr/bin/env bash
set -euo pipefail

# Evidence hygiene scanner. It counts violations without echoing matching
# lines. API/log inputs must already be redacted; rendered manifests are a
# separate scope and may contain Secret references, but never credential values.

command -v rg >/dev/null 2>&1 || {
  echo 'FAIL: ripgrep (rg) is required for NP-08 evidence scanning' >&2
  exit 1
}

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/np08-evidence.XXXXXX")"
trap 'rm -rf "${tmpdir}"' EXIT

api_inputs=()
log_inputs=()
manifest_inputs=()
stdin_kind=''

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --api)
      api_inputs+=("${2:-}")
      shift 2
      ;;
    --logs)
      log_inputs+=("${2:-}")
      shift 2
      ;;
    --manifest)
      manifest_inputs+=("${2:-}")
      shift 2
      ;;
    --stdin-kind)
      stdin_kind="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: $0 [--api file] [--logs file] [--manifest file] [--stdin-kind api|logs|manifest]" >&2
      exit 2
      ;;
  esac
done

if [[ "${#api_inputs[@]}" -eq 0 && "${#log_inputs[@]}" -eq 0 && "${#manifest_inputs[@]}" -eq 0 && -z "${stdin_kind}" ]]; then
  echo "usage: $0 [--api file] [--logs file] [--manifest file] [--stdin-kind api|logs|manifest]" >&2
  exit 2
fi

copy_input() {
  local source="$1"
  local destination="$2"
  if [[ ! -f "${source}" || -L "${source}" ]]; then
    echo 'FAIL: evidence input is absent or a symlink' >&2
    exit 1
  fi
  cp -- "${source}" "${destination}"
}

scan_scope() {
  local scope="$1"
  local pattern="$2"
  shift 2
  local count=0
  local input
  for input in "$@"; do
    local hits="${tmpdir}/${scope}-${count}.hits"
    local rg_status
    if rg -n -I -i --no-messages -e "${pattern}" "${input}" >"${hits}"; then
      count=$((count + $(wc -l <"${hits}")))
    else
      rg_status=$?
      if [[ "${rg_status}" -ne 1 ]]; then
        echo "FAIL: rg could not scan ${scope} evidence (exit ${rg_status})" >&2
        return 2
      fi
    fi
  done
  echo "${scope}_violations=${count}"
  [[ "${count}" -eq 0 ]]
}

declare -a api_files=()
declare -a manifest_files=()
for input in "${api_inputs[@]}" "${log_inputs[@]}"; do
  [[ -n "${input}" ]] || { echo 'FAIL: empty evidence path' >&2; exit 2; }
  destination="${tmpdir}/input-${#api_files[@]}"
  copy_input "${input}" "${destination}"
  api_files+=("${destination}")
done
for input in "${manifest_inputs[@]}"; do
  [[ -n "${input}" ]] || { echo 'FAIL: empty evidence path' >&2; exit 2; }
  destination="${tmpdir}/manifest-${#manifest_files[@]}"
  copy_input "${input}" "${destination}"
  manifest_files+=("${destination}")
done

if [[ -n "${stdin_kind}" ]]; then
  case "${stdin_kind}" in
    api|logs)
      cat >"${tmpdir}/stdin-api"
      api_files+=("${tmpdir}/stdin-api")
      ;;
    manifest)
      cat >"${tmpdir}/stdin-manifest"
      manifest_files+=("${tmpdir}/stdin-manifest")
      ;;
    *)
      echo 'FAIL: --stdin-kind must be api, logs, or manifest' >&2
      exit 2
      ;;
  esac
fi

api_pattern=$'(Bearer[[:space:]]+[A-Za-z0-9._~-]+|[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}|secretRef|secretKey|mcpHostAccessToken|mcpHostRefreshToken|mcpHostControlToken|authorization[[:space:]]*[:=][[:space:]]*[^[:space:]}" ]+|proxy-authorization[[:space:]]*[:=][[:space:]]*[^[:space:]}" ]+|token"[[:space:]]*:[[:space:]]*"[^"}]+)'
manifest_pattern='(Bearer[[:space:]]+[A-Za-z0-9._~-]+|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|-----BEGIN (RSA )?PRIVATE KEY-----)'

api_ok=1
if [[ "${#api_files[@]}" -gt 0 ]]; then
  scan_scope api "${api_pattern}" "${api_files[@]}" || api_ok=0
else
  echo 'api_violations=0'
fi
manifest_ok=1
if [[ "${#manifest_files[@]}" -gt 0 ]]; then
  scan_scope manifest "${manifest_pattern}" "${manifest_files[@]}" || manifest_ok=0
else
  echo 'manifest_violations=0'
fi

if [[ "${api_ok}" -ne 1 || "${manifest_ok}" -ne 1 ]]; then
  echo 'FAIL: NP-08 evidence hygiene violations found' >&2
  exit 1
fi
echo 'PASS: NP-08 evidence hygiene'
