#!/usr/bin/env bash
# Stop Dovecot and the SMTP sink started by start.sh. Safe to run when nothing is running.
#   ./stop.sh                       main instance only (profiles keep running)
#   ./stop.sh --profile <name|all>  iCloud-fidelity IMAP profile(s) only, see scripts/profiles.sh
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/common.sh"

# `--profile <name|all>` manages the iCloud-fidelity profiles instead (scripts/profiles.sh);
# `--profile main` or no flag = the main instance, exactly as before.
parse_profile_args "$@"
if [[ -n "$PROFILE_SEL" ]]; then
  exec "$ROOT/scripts/profiles.sh" stop "$PROFILE_SEL" ${PROFILE_REST_ARGS[@]+"${PROFILE_REST_ARGS[@]}"}
fi

if pid_alive "$DOVECOT_PID"; then
  pid="$(cat "$DOVECOT_PID")"
  log "stopping dovecot (pid $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 100); do proc_alive "$pid" || break; sleep 0.1; done
  if proc_alive "$pid"; then log "dovecot did not exit, sending SIGKILL"; kill -KILL "$pid" 2>/dev/null || true; fi
else
  log "dovecot not running"
fi
rm -f "$DOVECOT_PID"

if pid_alive "$SMTP_PID"; then
  pid="$(cat "$SMTP_PID")"
  log "stopping smtp sink (pid $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do proc_alive "$pid" || break; sleep 0.1; done
  if proc_alive "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
else
  log "smtp sink not running"
fi
rm -f "$SMTP_PID"

wait_port_closed "$IMAP_PORT" "dovecot" 10 || true
wait_port_closed "$IMAPS_PORT" "dovecot" 10 || true
wait_port_closed "$SMTP_PORT" "smtp sink" 10 || true
log "stopped"
