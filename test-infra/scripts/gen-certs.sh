#!/usr/bin/env bash
# Generates a throw-away test CA and a server certificate signed by it.
# Used by Dovecot (port 1993 implicit TLS, STARTTLS on 1143) and the SMTP sink (STARTTLS on 1587).
# Clients can either trust certs/ca.crt (preferred) or use rejectUnauthorized:false.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERTS="$ROOT/certs"
mkdir -p "$CERTS"
cd "$CERTS"

if [[ -s server.crt && -s server.key && -s ca.crt && "${1:-}" != "--force" ]]; then
  echo "[gen-certs] certificates already present in $CERTS (use --force to regenerate)"
  exit 0
fi

rm -f ca.key ca.crt ca.srl server.key server.csr server.crt server.ext

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -subj "/O=icloud-mail-mcp test infra/CN=icloud-mail-mcp Test CA" \
  -keyout ca.key -out ca.crt \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

openssl req -newkey rsa:2048 -nodes -sha256 \
  -subj "/O=icloud-mail-mcp test infra/CN=localhost" \
  -keyout server.key -out server.csr 2>/dev/null

cat > server.ext <<'EXT'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1,DNS:imap.icloud.test,DNS:smtp.icloud.test
EXT

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -sha256 -extfile server.ext -out server.crt 2>/dev/null

rm -f server.csr server.ext ca.srl
chmod 600 server.key ca.key
chmod 644 server.crt ca.crt
echo "[gen-certs] wrote $CERTS/{ca.crt,ca.key,server.crt,server.key}"
openssl x509 -in server.crt -noout -subject -issuer -ext subjectAltName
