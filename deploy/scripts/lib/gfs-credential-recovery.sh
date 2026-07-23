#!/usr/bin/env bash
# Explicit recovery decision for an abandoned credential in `applying`.

dsn_authentication_state() {
  local rc
  if dsn_authenticates_as "$1" "$2"; then
    printf authenticated
    return 0
  else
    rc=$?
  fi
  if [ "$rc" -eq 1 ]; then
    printf rejected
  else
    printf unavailable
  fi
}

require_authenticated_dsn() {
  local state
  state="$(dsn_authentication_state "$1" "$2")"
  [ "$state" = authenticated ] && return 0
  [ "$state" = rejected ] && die "$3 authentication rejected"
  die "$3 authentication probe unavailable"
}

authenticate_or_restore_nologin() {
  local role="$1" kind="$2" active="$3" lifecycle="$4" context="$5" state
  state="$(dsn_authentication_state "$active" "$role")"
  [ "$state" = authenticated ] && return 0
  [ "$state" = unavailable ] && die "${context} authentication probe unavailable; refusing credential mutation"
  restore_nologin_role_from_active "$role" "$kind" "$active" "$lifecycle" \
    || die "${context} authentication rejected and the role is not safely restorable from NOLOGIN"
}

recover_abandoned_applying() {
  local role="$1" secret="$2" active="$3" pending="$4" login_state pending_auth active_auth
  [ -n "$pending" ] || die "${GFS_NS}/${secret} is applying without a pending candidate"
  dsn_has_role "$pending" "$role" || die "${GFS_NS}/${secret} contains an invalid applying candidate"
  [ "${GFS_RECOVER_ABANDONED_STATE:-false}" = true ] \
    || die "${GFS_NS}/${secret} is applying; confirm the prior process ended, then retry with GFS_RECOVER_ABANDONED_STATE=true"

  pending_auth="$(dsn_authentication_state "$pending" "$role")"
  case "$pending_auth" in
    authenticated)
      log "Recovering an explicitly confirmed applying candidate"
      printf applied
      return 0
      ;;
    unavailable)
      die "candidate authentication probe is unavailable; refusing credential recovery"
      ;;
  esac
  if [ -n "$active" ]; then
    active_auth="$(dsn_authentication_state "$active" "$role")"
    case "$active_auth" in
      authenticated)
        log "Releasing an explicitly confirmed applying candidate whose database change did not commit"
        printf '%s' "$pending" | release_abandoned_candidate "$secret" \
          || die "abandoned applying candidate changed during recovery"
        printf pending
        return 0
        ;;
      unavailable)
        die "active authentication probe is unavailable; refusing credential recovery"
        ;;
    esac
  fi
  if [ -z "$active" ]; then
    login_state="$(role_can_login "$role")" \
      || die "cannot determine role state while recovering fresh credential bootstrap"
    if [ "$login_state" = f ]; then
      log "Releasing a fresh applying candidate because the database role remains NOLOGIN"
      printf '%s' "$pending" | release_abandoned_candidate "$secret" \
        || die "fresh applying candidate changed during recovery"
      printf pending
      return 0
    fi
  fi
  die "abandoned applying state matches neither committed nor pending credential; manual database recovery required"
}

restore_nologin_role_from_active() {
  local role="$1" kind="$2" active="$3" state="$4" login_state password auth_state
  [ "${GFS_RESTORE_ACTIVE_NOLOGIN:-false}" = true ] || return 1
  [ "$state" = ready ] || return 1
  login_state="$(role_can_login "$role")" || return 1
  [ "$login_state" = f ] || return 1
  verify_role_contract "$role" "$kind" false || return 1
  password="$(printf '%s' "$active" | gfs_dsn_password)" || return 1
  set_role_password "$role" "$password" || return 1
  unset password
  auth_state="$(dsn_authentication_state "$active" "$role")"
  if [ "$auth_state" != authenticated ] || ! verify_role_contract "$role" "$kind"; then
    if ! disable_role_login "$role"; then
      log "ERROR: failed to compensate ${role} back to NOLOGIN after restore verification failed"
    fi
    return 1
  fi
  log "Restored ${kind} LOGIN from its unchanged committed DSN after database bootstrap"
}
