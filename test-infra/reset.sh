#!/usr/bin/env bash
# Full reset: stop servers, wipe all mail + captured SMTP output, start, and seed fixtures.
# After a reset every mailbox has a fresh UIDVALIDITY and UIDs start at 1, so the UIDs listed in
# README.md / fixtures/manifest.json are exact.
#   ./reset.sh                       main instance (also empties smtp-out/)
#   ./reset.sh --profile <name|all>  iCloud-fidelity IMAP profile(s) only, see scripts/profiles.sh
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/common.sh"

# `--profile <name|all>` manages the iCloud-fidelity profiles instead (scripts/profiles.sh);
# `--profile main` or no flag = the main instance, exactly as before.
parse_profile_args "$@"
if [[ -n "$PROFILE_SEL" ]]; then
  exec "$ROOT/scripts/profiles.sh" reset "$PROFILE_SEL" ${PROFILE_REST_ARGS[@]+"${PROFILE_REST_ARGS[@]}"}
fi

"$ROOT/stop.sh"
log "wiping $MAIL_DIR, $OUT_DIR and dovecot state"
rm -rf "${MAIL_DIR:?}"/* "${OUT_DIR:?}"/* "$RUN_DIR/dovecot-state"
"$ROOT/start.sh"
log "seeding fixtures"
"$NODE_BIN" "$ROOT/scripts/seed.mjs" ${PROFILE_REST_ARGS[@]+"${PROFILE_REST_ARGS[@]}"}
