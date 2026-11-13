#!/usr/bin/env bash
# Radicale CalDAV server standing in for iCloud Calendar (caldav.icloud.com) in the calendar
# integration tests. Optional, like the iCloud-fidelity IMAP profiles: the integration globalSetup
# starts it when needed (set ALLOW_CALDAV_SKIP=1 to skip the calendar tests deliberately).
#
#   ./caldav.sh start    start (idempotent) and wait for https://127.0.0.1:${CALDAV_PORT:-5232}
#   ./caldav.sh stop     stop (SIGTERM, SIGKILL after 10 s)
#   ./caldav.sh reset    stop, wipe every calendar, start (the tests seed their own events)
#   ./caldav.sh status   show pid and port
#
# Login: testuser@icloud.test / app-specific-pass (radicale/users). TLS: certs/server.crt, signed by
# the test CA certs/ca.crt (same as Dovecot). State: run/radicale/; log: logs/radicale.log.
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/common.sh"

CALDAV_PORT="${CALDAV_PORT:-5232}"
RADICALE_DIR="$RUN_DIR/radicale"
RADICALE_CONF="$RADICALE_DIR/config"
RADICALE_PID="$RADICALE_DIR/radicale.pid"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || true)}"

have_radicale() {
  [[ -n "$PYTHON_BIN" ]] && "$PYTHON_BIN" -c 'import radicale' 2>/dev/null
}

start() {
  have_radicale || die "Radicale not found. Install it: apt-get install -y radicale (or: pip install radicale)"
  mkdir -p "$RADICALE_DIR/collections" "$LOG_DIR"
  "$ROOT/scripts/gen-certs.sh" >/dev/null
  if pid_alive "$RADICALE_PID"; then
    log "radicale already running (pid $(cat "$RADICALE_PID"))"
  else
    port_open "$CALDAV_PORT" && die "port $CALDAV_PORT is already in use by another process"
    sed -e "s#@ROOT@#$ROOT#g" -e "s#@PORT@#$CALDAV_PORT#g" "$ROOT/radicale/config.tmpl" > "$RADICALE_CONF"
    log "starting radicale ($("$PYTHON_BIN" -c 'import radicale; print(radicale.VERSION)' 2>/dev/null || echo '?'))"
    nohup setsid "$PYTHON_BIN" -m radicale --config "$RADICALE_CONF" >>"$LOG_DIR/radicale.log" 2>&1 < /dev/null &
    echo $! > "$RADICALE_PID"
  fi
  wait_port "$CALDAV_PORT" "radicale CalDAV (https)"
  log "ready. user=testuser@icloud.test pass=app-specific-pass  (https://127.0.0.1:$CALDAV_PORT, CA certs/ca.crt)"
}

stop() {
  if pid_alive "$RADICALE_PID"; then
    local pid
    pid="$(cat "$RADICALE_PID")"
    log "stopping radicale (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do proc_alive "$pid" || break; sleep 0.1; done
    if proc_alive "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
  else
    log "radicale not running"
  fi
  rm -f "$RADICALE_PID"
  wait_port_closed "$CALDAV_PORT" "radicale" 10 || true
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset)
    stop
    log "wiping $RADICALE_DIR/collections"
    rm -rf "${RADICALE_DIR:?}/collections"
    start
    ;;
  status)
    if pid_alive "$RADICALE_PID"; then log "radicale running (pid $(cat "$RADICALE_PID")) on $CALDAV_PORT"; else log "radicale not running"; fi
    ;;
  *)
    echo "usage: $(basename "$0") start|stop|reset|status" >&2
    exit 2
    ;;
esac
