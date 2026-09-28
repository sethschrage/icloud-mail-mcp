#!/usr/bin/env bash
# Start the local iCloud-like mail server (Dovecot IMAP + Node SMTP sink) in the background.
# Idempotent: already-running components are left alone. Blocks until all ports accept connections.
#   ./start.sh                       main instance (IMAP 1143/1993 + SMTP sink 1587)
#   ./start.sh --profile <name|all>  iCloud-fidelity IMAP profile(s) only, see scripts/profiles.sh
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/common.sh"

# `--profile <name|all>` manages the iCloud-fidelity profiles instead (scripts/profiles.sh);
# `--profile main` or no flag = the main instance, exactly as before.
parse_profile_args "$@"
if [[ -n "$PROFILE_SEL" ]]; then
  exec "$ROOT/scripts/profiles.sh" start "$PROFILE_SEL" ${PROFILE_REST_ARGS[@]+"${PROFILE_REST_ARGS[@]}"}
fi

[[ -x "$DOVECOT_BIN" ]] || die "dovecot not found. Install it: apt-get install -y dovecot-imapd"
[[ -n "$NODE_BIN" ]] || die "node not found (need Node >= 20)"

mkdir -p "$RUN_DIR" "$LOG_DIR" "$MAIL_DIR" "$OUT_DIR"

# 1. npm deps for the SMTP sink / seed / verify scripts
if [[ ! -d "$ROOT/node_modules/smtp-server" || ! -d "$ROOT/node_modules/imapflow" ]]; then
  log "installing node dependencies"
  (cd "$ROOT" && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null)
fi

# 2. TLS material
"$ROOT/scripts/gen-certs.sh" >/dev/null

# 3. Dovecot
resolve_run_user
if [[ "$(id -u)" == "0" ]]; then
  chown -R "$RUN_USER:$RUN_GROUP" "$MAIL_DIR"
fi

if pid_alive "$DOVECOT_PID"; then
  log "dovecot already running (pid $(cat "$DOVECOT_PID"))"
else
  if port_open "$IMAP_PORT" || port_open "$IMAPS_PORT"; then
    die "port $IMAP_PORT or $IMAPS_PORT is already in use by another process"
  fi
  render_dovecot_conf
  "$DOVECONF_BIN" -c "$DOVECOT_CONF" -n >/dev/null || die "invalid dovecot config: $DOVECOT_CONF"
  log "starting dovecot ($("$DOVECOT_BIN" --version | cut -d' ' -f1)) with $DOVECOT_CONF"
  # redirect stdio so the daemon does not hold the caller's pipes open (e.g. `./start.sh | tail`)
  "$DOVECOT_BIN" -c "$DOVECOT_CONF" </dev/null >>"$LOG_DIR/dovecot.stdio.log" 2>&1
fi

# 4. SMTP sink
if pid_alive "$SMTP_PID"; then
  log "smtp sink already running (pid $(cat "$SMTP_PID"))"
else
  if port_open "$SMTP_PORT"; then
    die "port $SMTP_PORT is already in use by another process"
  fi
  log "starting smtp sink"
  SMTP_PORT="$SMTP_PORT" nohup setsid "$NODE_BIN" "$ROOT/scripts/smtp-sink.mjs" \
    >>"$LOG_DIR/smtp-sink.log" 2>&1 < /dev/null &
  echo $! > "$SMTP_PID"
fi

wait_port "$IMAP_PORT" "dovecot IMAP (plaintext/STARTTLS)"
wait_port "$IMAPS_PORT" "dovecot IMAPS (implicit TLS)"
wait_port "$SMTP_PORT" "smtp sink (plaintext/STARTTLS)"
log "ready. user=testuser pass=app-specific-pass  (IMAP $IMAP_PORT, IMAPS $IMAPS_PORT, SMTP $SMTP_PORT)"
