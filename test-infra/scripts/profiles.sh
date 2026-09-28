#!/usr/bin/env bash
# iCloud-fidelity Dovecot profiles: extra, fully independent IMAP instances that differ from the main
# instance only in what they advertise (see dovecot/profiles/*.env and README.md).
#
#   scripts/profiles.sh start  <profile|all>   start (idempotent) and wait for both ports
#   scripts/profiles.sh stop   <profile|all>   stop (SIGTERM, SIGKILL after 10 s)
#   scripts/profiles.sh reset  <profile|all>   stop, wipe that profile's mail + state, start, seed
#   scripts/profiles.sh status [profile|all]   show pid / ports
#   scripts/profiles.sh list                   list profile names, ports and descriptions
#
# start.sh / stop.sh / reset.sh with `--profile <profile|all>` call this script. "all" means every
# profile in dovecot/profiles/, never the main instance. Profiles are IMAP-only: the SMTP sink on 1587
# (and smtp-out/) belongs to the main instance and is never started, stopped or wiped from here.
#
# Each profile has its own config, base_dir, state_dir, Maildir store and log:
#   run/profiles/<name>/dovecot.conf     rendered from dovecot/dovecot.conf.tmpl + the profile overlay
#   run/profiles/<name>/dovecot/         base_dir (master.pid, sockets)
#   run/profiles/<name>/dovecot-state/   state_dir
#   run/profiles/<name>/mail/            Maildir store (home = mail/<local part>)
#   run/profiles/<name>/manifest.json    fixture manifest written by the last reset's seed
#   logs/dovecot-<name>.log              Dovecot log (plus logs/dovecot-<name>.stdio.log)
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") start|stop|reset <profile|all>
       $(basename "$0") status [profile|all]
       $(basename "$0") list
profiles: $(known_profiles | tr '\n' ' ')
EOF
  exit 2
}

# Expands a selection ("all" or a profile name) into the PROFILE_NAMES array.
expand_selection() {
  local sel="$1"
  PROFILE_NAMES=()
  if [[ "$sel" == "all" ]]; then
    local name
    while IFS= read -r name; do PROFILE_NAMES+=("$name"); done < <(known_profiles)
    ((${#PROFILE_NAMES[@]} > 0)) || die "no profiles defined in $PROFILE_DEF_DIR"
    return
  fi
  [[ "$sel" =~ ^[a-z0-9][a-z0-9-]*$ && -f "$PROFILE_DEF_DIR/$sel.env" ]] \
    || die "unknown profile '$sel'. Known profiles: $(known_profiles | tr '\n' ' ')(or 'all'; 'main' is the default instance)"
  PROFILE_NAMES=("$sel")
}

# Points every per-instance variable from common.sh at profile $1.
load_profile() {
  local name="$1" def="$PROFILE_DEF_DIR/$1.env"
  PROFILE_DESCRIPTION="" PROFILE_IMAP_PORT="" PROFILE_IMAPS_PORT="" PROFILE_SPECIAL_USE="" PROFILE_CAPABILITY=""
  # shellcheck source=/dev/null
  source "$def"
  [[ "$PROFILE_IMAP_PORT" =~ ^[0-9]+$ && "$PROFILE_IMAPS_PORT" =~ ^[0-9]+$ ]] || die "$def: PROFILE_IMAP_PORT/PROFILE_IMAPS_PORT must be numbers"
  [[ -n "$PROFILE_CAPABILITY" ]] || die "$def: PROFILE_CAPABILITY is empty"
  [[ "$PROFILE_CAPABILITY" != *$'\n'* && "$PROFILE_CAPABILITY" != +* ]] || die "$def: PROFILE_CAPABILITY must be one line and an explicit list (no leading +)"
  case "$PROFILE_SPECIAL_USE" in yes|no) ;; *) die "$def: PROFILE_SPECIAL_USE must be yes or no" ;; esac
  local main_port
  for main_port in 1143 1993 1587; do
    [[ "$PROFILE_IMAP_PORT" != "$main_port" && "$PROFILE_IMAPS_PORT" != "$main_port" ]] \
      || die "$def: port $main_port belongs to the main instance"
  done

  PROFILE_NAME="$name"
  PROFILE_DIR="$PROFILE_RUN_ROOT/$name"
  PROFILE_MANIFEST="$PROFILE_DIR/manifest.json"
  IMAP_PORT="$PROFILE_IMAP_PORT"
  IMAPS_PORT="$PROFILE_IMAPS_PORT"
  MAIL_DIR="$PROFILE_DIR/mail"
  DOVECOT_CONF="$PROFILE_DIR/dovecot.conf"
  DOVECOT_BASE_DIR="$PROFILE_DIR/dovecot"
  DOVECOT_PID="$DOVECOT_BASE_DIR/master.pid"
  DOVECOT_STATE_DIR="$PROFILE_DIR/dovecot-state"
  DOVECOT_LOG="$LOG_DIR/dovecot-$name.log"
  DOVECOT_STDIO_LOG="$LOG_DIR/dovecot-$name.stdio.log"
  DOVECOT_INSTANCE="icloud-test-dovecot-$name"
  DOVECOT_CONF_ORIGIN="scripts/profiles.sh (profile $name)"
  if [[ "$PROFILE_SPECIAL_USE" == "no" ]]; then DOVECOT_STRIP_SPECIAL_USE=yes; else DOVECOT_STRIP_SPECIAL_USE=no; fi
  DOVECOT_EXTRA_CONF="# ---------------------------------------------------------------- profile \"$name\" overlay
# $PROFILE_DESCRIPTION
# special_use attributes: $([[ "$PROFILE_SPECIAL_USE" == no ]] && echo 'removed from all mailboxes' || echo 'kept')
# An explicit (non-+) imap_capability replaces Dovecot's list for both imap-login (pre-login) and imap.
imap_capability = $PROFILE_CAPABILITY"
}

ensure_node_deps() {
  [[ -n "$NODE_BIN" ]] || die "node not found (need Node >= 20)"
  if [[ ! -d "$ROOT/node_modules/smtp-server" || ! -d "$ROOT/node_modules/imapflow" ]]; then
    log "installing node dependencies"
    (cd "$ROOT" && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null)
  fi
}

start_profile() {
  load_profile "$1"
  [[ -x "$DOVECOT_BIN" ]] || die "dovecot not found. Install it: apt-get install -y dovecot-imapd"
  mkdir -p "$PROFILE_DIR" "$MAIL_DIR" "$LOG_DIR"
  "$ROOT/scripts/gen-certs.sh" >/dev/null

  resolve_run_user
  if [[ "$(id -u)" == "0" ]]; then
    chown -R "$RUN_USER:$RUN_GROUP" "$MAIL_DIR"
  fi

  if pid_alive "$DOVECOT_PID"; then
    log "[$PROFILE_NAME] dovecot already running (pid $(cat "$DOVECOT_PID"))"
  else
    if port_open "$IMAP_PORT" || port_open "$IMAPS_PORT"; then
      die "[$PROFILE_NAME] port $IMAP_PORT or $IMAPS_PORT is already in use by another process"
    fi
    render_dovecot_conf
    "$DOVECONF_BIN" -c "$DOVECOT_CONF" -n >/dev/null || die "[$PROFILE_NAME] invalid dovecot config: $DOVECOT_CONF"
    log "[$PROFILE_NAME] starting dovecot with $DOVECOT_CONF"
    "$DOVECOT_BIN" -c "$DOVECOT_CONF" </dev/null >>"$DOVECOT_STDIO_LOG" 2>&1
  fi
  wait_port "$IMAP_PORT" "[$PROFILE_NAME] dovecot IMAP (plaintext/STARTTLS)"
  wait_port "$IMAPS_PORT" "[$PROFILE_NAME] dovecot IMAPS (implicit TLS)"
  log "[$PROFILE_NAME] ready: IMAP $IMAP_PORT, IMAPS $IMAPS_PORT ($PROFILE_DESCRIPTION)"
}

stop_profile() {
  load_profile "$1"
  local pid
  if pid_alive "$DOVECOT_PID"; then
    pid="$(tr -d '[:space:]' < "$DOVECOT_PID")"
    log "[$PROFILE_NAME] stopping dovecot (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do proc_alive "$pid" || break; sleep 0.1; done
    if proc_alive "$pid"; then log "[$PROFILE_NAME] dovecot did not exit, sending SIGKILL"; kill -KILL "$pid" 2>/dev/null || true; fi
  else
    log "[$PROFILE_NAME] dovecot not running"
  fi
  rm -f "$DOVECOT_PID"
  wait_port_closed "$IMAP_PORT" "[$PROFILE_NAME] dovecot" 10 || true
  wait_port_closed "$IMAPS_PORT" "[$PROFILE_NAME] dovecot" 10 || true
}

reset_profile() {
  local name="$1"
  shift
  stop_profile "$name"
  # PROFILE_DIR comes from load_profile and always lies under run/profiles/
  [[ "$PROFILE_DIR" == "$PROFILE_RUN_ROOT/"?* ]] || die "refusing to wipe unexpected directory '$PROFILE_DIR'"
  log "[$name] wiping $MAIL_DIR and $DOVECOT_STATE_DIR"
  rm -rf "${MAIL_DIR:?}" "${DOVECOT_STATE_DIR:?}" "$PROFILE_MANIFEST"
  start_profile "$name"
  ensure_node_deps
  log "[$name] seeding fixtures"
  # Explicit env so a caller's IMAP_* variables (e.g. for the main instance) cannot redirect the seed.
  IMAP_HOST=127.0.0.1 IMAP_PORT="$IMAP_PORT" IMAP_SECURE=0 IMAP_USER=testuser IMAP_PASS=app-specific-pass \
    SEED_MANIFEST="$PROFILE_MANIFEST" SEED_LABEL="seed:$name" "$NODE_BIN" "$ROOT/scripts/seed.mjs" "$@"
  if [[ -f "$ROOT/fixtures/manifest.json" ]]; then
    if cmp -s "$PROFILE_MANIFEST" "$ROOT/fixtures/manifest.json"; then
      log "[$name] manifest identical to fixtures/manifest.json (canonical UIDs)"
    else
      log "WARNING: [$name] $PROFILE_MANIFEST differs from fixtures/manifest.json (fixtures changed since the main instance was seeded?)"
    fi
  fi
}

status_profile() {
  load_profile "$1"
  local state="stopped" imap="closed" imaps="closed"
  if pid_alive "$DOVECOT_PID"; then state="running (pid $(tr -d '[:space:]' < "$DOVECOT_PID"))"; fi
  if port_open "$IMAP_PORT"; then imap="open"; fi
  if port_open "$IMAPS_PORT"; then imaps="open"; fi
  printf '%-11s %-22s IMAP %s (%s)  IMAPS %s (%s)  log %s\n' "$PROFILE_NAME" "$state" "$IMAP_PORT" "$imap" "$IMAPS_PORT" "$imaps" "${DOVECOT_LOG#"$ROOT"/}"
}

list_profiles() {
  local name
  while IFS= read -r name; do
    load_profile "$name"
    printf '%-11s IMAP %s  IMAPS %s  %s\n' "$name" "$IMAP_PORT" "$IMAPS_PORT" "$PROFILE_DESCRIPTION"
  done < <(known_profiles)
}

(($# >= 1)) || usage
action="$1"
shift
case "$action" in
  start|stop|reset)
    (($# >= 1)) || usage
    selection="$1"
    shift
    [[ "$action" == reset || $# -eq 0 ]] || die "unexpected arguments: $*"
    expand_selection "$selection"
    for name in "${PROFILE_NAMES[@]}"; do
      case "$action" in
        start) start_profile "$name" ;;
        stop) stop_profile "$name" ;;
        reset) reset_profile "$name" "$@" ;;
      esac
    done
    [[ "$action" != stop ]] || log "stopped: ${PROFILE_NAMES[*]}"
    ;;
  status)
    expand_selection "${1:-all}"
    for name in "${PROFILE_NAMES[@]}"; do status_profile "$name"; done
    ;;
  list)
    list_profiles
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    ;;
esac
