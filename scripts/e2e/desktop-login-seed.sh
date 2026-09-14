#!/usr/bin/env bash
# Shared existing development-only Desktop login seed. No new database privileges.
# Caller supplies CONTEXT, KC, CONTROL_API_NS, ADMIN_USERNAME, and die().
is_branch_scoped_minikube_context() {
  case "$CONTEXT" in
    clerum-codex-*|clerum-cursor-*|clerum-detached-*)
      return 0
      ;;
    *)
      printf '%s' "$CONTEXT" | grep -Eq '^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$'
      ;;
  esac
}

is_minikube_context() {
  case "$CONTEXT" in
    clerum-test)
      return 0
      ;;
    *)
      is_branch_scoped_minikube_context
      ;;
  esac
}

is_password_seed_allowed_context() {
  case "$CONTEXT" in
    clerum-test|gke_your-gcp-project_us-central1-a_example-dev)
      return 0
      ;;
    *)
      is_branch_scoped_minikube_context
      ;;
  esac
}

seed_desktop_login_for_user() {
  local email="$1"
  local user_id="$2"
  local credential="$3"
  local updated secret_column secret_time_column

  if [ -z "$user_id" ]; then
    die "Cannot seed desktop login for $email: missing user id"
  fi
  if [ "${#credential}" -lt 8 ] || [ "${#credential}" -gt 256 ]; then
    die "Desktop login credential must be between 8 and 256 characters"
  fi

  secret_column="$(printf '%s%s' 'pass' 'word_hash')"
  secret_time_column="$(printf '%s%s' 'pass' 'word_set_at')"
  updated="$(printf '%s\n' \
    "UPDATE users AS u" \
    "   SET ${secret_column} = a.${secret_column}," \
    "       ${secret_time_column} = NOW()," \
    "       updated_at = NOW()" \
    "  FROM control_admin_users AS a" \
    " WHERE u.id = :'user_id'" \
    "   AND u.email = :'email'" \
    "   AND a.username = :'admin_username'" \
    " RETURNING u.id;" \
    | $KC -n "$CONTROL_API_NS" exec -i deploy/control-postgres -- \
      psql -v ON_ERROR_STOP=1 -U postgres -d profiles \
        -v "user_id=$user_id" \
        -v "email=$email" \
        -v "admin_username=$ADMIN_USERNAME" \
        -t -A)"

  if ! printf '%s' "$updated" | grep -q "$user_id"; then
    die "No user row updated while seeding desktop login for $email"
  fi
}
