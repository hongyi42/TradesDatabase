#!/usr/bin/env bash
# install.sh <seat> — install the seat glue on trades-box-1 for one seat.
# Run as ROOT from the staged directory (stage.sh output, copied to the box):
#
#   SEAT_TENANT_ID=… SEAT_TECHNICIAN_REF=… SEAT_TELEGRAM_USER_ID=… SEAT_TZ=… \
#     bash /tmp/seat-glue-stage/install.sh s5
#
# The four settings are NOT secrets (read them from the pilot: technicians where
# sandbox_ref = the seat, joined to tenants.timezone). Every SECRET comes from a
# file already on this box — no new secret is minted and none is printed:
#   TELEGRAM_BOT_TOKEN       <- /root/seats/<seat>.env
#   GATEWAY_IDENTITY_SECRET  <- /etc/doorman/doorman.env   (the glue signs identity itself)
#   SPINE_MCP_URL            <- /etc/doorman/doorman.env   (MCP_UPSTREAM_URL)
#   OPENROUTER_API_KEY       <- /etc/nemoclaw/openrouter.env
#
# Idempotent: re-run it to upgrade the code. It never enables or starts the
# unit — cutover.sh does that, after the old openclaw seat has lost the token.
set -euo pipefail

SEAT="${1:?usage: install.sh <seat>  (with SEAT_TENANT_ID SEAT_TECHNICIAN_REF SEAT_TELEGRAM_USER_ID SEAT_TZ in the env)}"
[[ "$SEAT" =~ ^[a-z0-9_]+$ ]] || { echo "install: bad seat ref" >&2; exit 1; }
: "${SEAT_TENANT_ID:?}" "${SEAT_TECHNICIAN_REF:?}" "${SEAT_TELEGRAM_USER_ID:?}" "${SEAT_TZ:?}"
[[ "$SEAT_TENANT_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "install: SEAT_TENANT_ID is not a uuid" >&2; exit 1; }
[[ "$SEAT_TELEGRAM_USER_ID" =~ ^[1-9][0-9]{4,19}$ ]] || { echo "install: bad SEAT_TELEGRAM_USER_ID" >&2; exit 1; }
[ -f "/usr/share/zoneinfo/$SEAT_TZ" ] || { echo "install: unknown timezone $SEAT_TZ" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "install: run as root" >&2; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
NODE=/usr/local/bin/node
PREFIX=/opt/seat-glue
TOOLS="$PREFIX/.tools"
log() { printf '== %s\n' "$*"; }

# 1. The service user and its state root (StateDirectory= makes the per-seat dir).
id seatglue >/dev/null 2>&1 || useradd --system --home-dir /var/lib/seat-glue --shell /usr/sbin/nologin seatglue
install -d -o seatglue -g seatglue -m 0700 /var/lib/seat-glue
log "user seatglue, /var/lib/seat-glue ready"

# 2. npm. The box ships a bare node binary (no npm): take npm from the official
#    tarball of the SAME node version, checksum-verified — step 0's proven path.
v="$("$NODE" -v)"                       # prints the leading v already
tarball="node-${v}-linux-x64.tar.xz"
npmdir="$TOOLS/node-${v}-linux-x64/bin"
if [ ! -x "$npmdir/npm" ]; then
  install -d -m 0755 "$TOOLS"
  curl -fsSL --max-time 300 -o "$TOOLS/$tarball" "https://nodejs.org/dist/${v}/${tarball}"
  curl -fsSL --max-time 60 -o "$TOOLS/SHASUMS256.txt" "https://nodejs.org/dist/${v}/SHASUMS256.txt"
  (cd "$TOOLS" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -) || { echo "install: node tarball checksum FAILED" >&2; exit 1; }
  tar -xJf "$TOOLS/$tarball" -C "$TOOLS"
  rm -f "$TOOLS/$tarball"
fi
log "npm $("$npmdir/npm" -v) from ${tarball}"

# 3. The code and its one dependency (the SDK, with the linux-x64 engine).
install -d -m 0755 "$PREFIX" "$PREFIX/app"
rm -f "$PREFIX"/app/*.js
cp "$here"/app/*.js "$PREFIX/app/"
cp "$here/package.json" "$here/package-lock.json" "$PREFIX/"
(cd "$PREFIX" && PATH="$npmdir:$PATH" npm ci --omit=dev --no-audit --no-fund >/dev/null)
log "code in $PREFIX ($(ls "$PREFIX"/app | wc -l | tr -d ' ') modules)"

# 4. The seat's env file, assembled from files already on the box. Values go
#    through variables only — never onto a command line, never to the terminal.
val() { # $1 file, $2 key -> the value, surrounding quotes stripped
  local line
  line="$(grep -m1 "^$2=" "$1" 2>/dev/null || true)"
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}
bot="$(val "/root/seats/${SEAT}.env" TELEGRAM_BOT_TOKEN)"
secret="$(val /etc/doorman/doorman.env GATEWAY_IDENTITY_SECRET)"
spine="$(val /etc/doorman/doorman.env MCP_UPSTREAM_URL)"
orkey="$(val /etc/nemoclaw/openrouter.env OPENROUTER_API_KEY)"
for pair in "TELEGRAM_BOT_TOKEN:$bot" "GATEWAY_IDENTITY_SECRET:$secret" "SPINE_MCP_URL:$spine" "OPENROUTER_API_KEY:$orkey"; do
  [ -n "${pair#*:}" ] || { echo "install: ${pair%%:*} not found on this box" >&2; exit 1; }
done
install -d -o root -g root -m 0700 /etc/seat-glue
( umask 077
  cat > "/etc/seat-glue/${SEAT}.env" <<EOF
TELEGRAM_BOT_TOKEN=${bot}
GATEWAY_IDENTITY_SECRET=${secret}
SPINE_MCP_URL=${spine}
OPENROUTER_API_KEY=${orkey}
SEAT_TENANT_ID=${SEAT_TENANT_ID}
SEAT_TECHNICIAN_REF=${SEAT_TECHNICIAN_REF}
SEAT_TELEGRAM_USER_ID=${SEAT_TELEGRAM_USER_ID}
# Hand-set for step 1; step 4 has Render send each seat's timezone.
SEAT_TZ=${SEAT_TZ}
EOF
)
chmod 600 "/etc/seat-glue/${SEAT}.env"
unset bot secret orkey
log "/etc/seat-glue/${SEAT}.env written (root, 0600)"

# 5. The unit, then prove the engine starts under the service user.
install -m 0644 "$here/seat-glue@.service" /etc/systemd/system/seat-glue@.service
systemctl daemon-reload
runuser -u seatglue -- env HOME=/var/lib/seat-glue "$NODE" "$PREFIX/app/main.js" --selfcheck
# An upgrade: a running glue keeps the old code until it restarts.
if systemctl is-active --quiet "seat-glue@${SEAT}"; then
  systemctl restart "seat-glue@${SEAT}"
  log "seat-glue@${SEAT} restarted on the new code"
else
  log "installed. NOT started — run cutover.sh ${SEAT} to move the bot over."
fi
