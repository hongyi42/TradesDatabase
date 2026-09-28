#!/usr/bin/env bash
# install.sh <seat> — install the seat glue on trades-box-1 for one seat, and
# mint the seat's token. Run as ROOT from the staged directory (stage.sh output,
# copied to the box):
#
#   bash /tmp/seat-glue-stage/install.sh s5
#
# No identity is typed here (step 4). The seat must already have its `seats` row
# on Render (scripts/assign-host.mjs add-glue-seat, or bind_telegram for a new
# hire); the glue asks Render who it is at every start (/seat/whoami).
#
# THE TOKEN. This box asks Render for the seat's token with its HOST token
# (/etc/doorman/badge-pull.env) and Render answers once — for a seat on THIS box
# only. The token goes straight from the response into the env file: never onto
# a command line, never to the terminal. Every run MINTS AGAIN, which is
# rotation: the previous token dies on its next request. So a run that fails
# after the mint and before the restart leaves the running glue on a dead token
# — rerun install.sh; it mints again.
#
# The other secrets come from files already on this box:
#   TELEGRAM_BOT_TOKEN  <- /root/bots/<bot handle>.env, else /root/seats/<seat>.env
#   SPINE_MCP_URL       <- /etc/doorman/doorman.env   (MCP_UPSTREAM_URL)
#   OPENROUTER_API_KEY  <- /etc/nemoclaw/openrouter.env
#   E2B_API_KEY         <- /etc/seat-glue/e2b.env (optional; step 2b, a manager's sandbox)
#
# Idempotent: re-run it to upgrade the code or rotate the token. It never enables
# or starts the unit — cutover.sh does that, after the old openclaw seat has
# lost the bot.
set -euo pipefail

SEAT="${1:?usage: install.sh <seat>}"
[[ "$SEAT" =~ ^[a-z0-9_]+$ ]] || { echo "install: bad seat ref" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "install: run as root" >&2; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
NODE=/usr/local/bin/node
PREFIX=/opt/seat-glue
NEXT="${PREFIX}.next"                   # built and self-checked here, then swapped in
TOOLS=/opt/seat-glue-tools              # outside PREFIX so the swap keeps it
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

# 3. The code and its one dependency (the SDK, with the linux-x64 engine), built
#    in $NEXT. The running copy in $PREFIX is not touched until step 6 — a
#    failed upgrade leaves the seat on its old code.
rm -rf "$NEXT"
install -d -m 0755 "$NEXT" "$NEXT/app"
cp "$here"/app/*.js "$NEXT/app/"
cp "$here/package.json" "$here/package-lock.json" "$NEXT/"
(cd "$NEXT" && PATH="$npmdir:$PATH" npm ci --omit=dev --no-audit --no-fund >/dev/null)
log "new code built in $NEXT ($(ls "$NEXT"/app | wc -l | tr -d ' ') modules)"

# 4. Prove the NEW engine starts under the service user — BEFORE the mint, so a
# build that cannot start never rotates a working token.
# From / — not the caller's cwd: run over ssh that is the operator's home,
# which is 0750 and closed to seatglue, and the engine dies on start
# (ERR_STREAM_DESTROYED, first install 2026-09-23). The unit sets its own.
(cd / && runuser -u seatglue -- env HOME=/var/lib/seat-glue "$NODE" "$NEXT/app/main.js" --selfcheck)

# 5. Mint the seat's token and assemble the env file NEXT TO the live one.
#    Values go through variables only — never onto a command line (the host
#    token rides a process-substituted header file), never to the terminal.
val() { # $1 file, $2 key -> the value, surrounding quotes stripped
  local line
  line="$(grep -m1 "^$2=" "$1" 2>/dev/null || true)"
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}
field() { # stdin JSON, $1 key -> its string value ('' when absent); the JSON never touches argv
  "$NODE" -e 'let d="";process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{try{const v=JSON.parse(d)[process.argv[1]];process.stdout.write(typeof v==="string"?v:"");}catch(e){}});' "$1"
}
hosttok="$(val /etc/doorman/badge-pull.env HOST_PULL_TOKEN)"
pullurl="$(val /etc/doorman/badge-pull.env PULL_URL)"
spine="$(val /etc/doorman/doorman.env MCP_UPSTREAM_URL)"
orkey="$(val /etc/nemoclaw/openrouter.env OPENROUTER_API_KEY)"
for pair in "HOST_PULL_TOKEN:$hosttok" "PULL_URL:$pullurl" "SPINE_MCP_URL:$spine" "OPENROUTER_API_KEY:$orkey"; do
  [ -n "${pair#*:}" ] || { echo "install: ${pair%%:*} not found on this box" >&2; exit 1; }
done
# Refuse BEFORE minting when no bot token can possibly be found — the mint
# rotates, and a run that dies after it leaves a running glue on a dead token.
# (Which /root/bots file applies is only known from the mint's reply.)
if [ ! -s "/root/seats/${SEAT}.env" ] && ! compgen -G '/root/bots/*.env' >/dev/null; then
  echo "install: no bot token on this box for ${SEAT} (/root/seats/${SEAT}.env or /root/bots/<handle>.env). Nothing changed." >&2
  exit 1
fi
resp="$(curl -sS --max-time 30 -w '\n%{http_code}' -X POST \
  -H @<(printf 'Authorization: Bearer %s\n' "$hosttok") \
  -H 'content-type: application/json' \
  --data "{\"seatRef\":\"${SEAT}\"}" \
  "${pullurl%/badges}/seat-token")" || { echo "install: could not reach Render — nothing changed" >&2; exit 1; }
unset hosttok
code="${resp##*$'\n'}"
resp="${resp%$'\n'*}"
case "$code" in
  200) ;;
  404) echo "install: Render has no seat ${SEAT} on this box — record it first (assign-host.mjs add-glue-seat). Nothing changed." >&2; exit 1 ;;
  409) echo "install: seat ${SEAT} belongs to a deactivated team member. Nothing changed." >&2; exit 1 ;;
  *)   echo "install: the token mint answered HTTP ${code}. Nothing changed." >&2; exit 1 ;;
esac
token="$(printf '%s' "$resp" | field token)"
handle="$(printf '%s' "$resp" | field botUsername)"
unset resp
[[ "$token" =~ ^st_[0-9a-f]{64}$ ]] || { echo "install: the mint returned no seat token" >&2; exit 1; }
botfile="/root/seats/${SEAT}.env"
if [ -n "$handle" ] && [ -f "/root/bots/${handle#@}.env" ]; then botfile="/root/bots/${handle#@}.env"; fi
bot="$(val "$botfile" TELEGRAM_BOT_TOKEN)"
[ -n "$bot" ] || { echo "install: no TELEGRAM_BOT_TOKEN in ${botfile} (a token WAS minted; rerun once the bot file is in place)" >&2; exit 1; }
install -d -o root -g root -m 0700 /etc/seat-glue
( umask 077
  printf 'TELEGRAM_BOT_TOKEN=%s\nSEAT_TOKEN=%s\nSPINE_MCP_URL=%s\nOPENROUTER_API_KEY=%s\n' \
    "$bot" "$token" "$spine" "$orkey" > "/etc/seat-glue/${SEAT}.env.new"
  # Step 2b: a manager's sandbox key, when the operator has put it on this box
  # (/etc/seat-glue/e2b.env, root 0600). Every seat gets it — bash cannot see the
  # tier — and the glue uses it for a manager only.
  e2bkey="$(val /etc/seat-glue/e2b.env E2B_API_KEY)"
  e2btpl="$(val /etc/seat-glue/e2b.env E2B_TEMPLATE)"
  if [ -n "$e2bkey" ]; then printf 'E2B_API_KEY=%s\n' "$e2bkey" >> "/etc/seat-glue/${SEAT}.env.new"; fi
  if [ -n "$e2btpl" ]; then printf 'E2B_TEMPLATE=%s\n' "$e2btpl" >> "/etc/seat-glue/${SEAT}.env.new"; fi
)
chmod 600 "/etc/seat-glue/${SEAT}.env.new"
unset bot token orkey e2bkey e2btpl
log "seat token minted; /etc/seat-glue/${SEAT}.env.new written (root, 0600)"

# 6. Swap in the new code, then its env file. A failure before the mint (step 5)
#    changed nothing. A failure after it left the old code and old env in place
#    — which still work on the FIRST switch (an HMAC env), but on a rerun the
#    old env's token is the one just revoked: rerun install.sh, it mints again.
#    (The bot-file check cannot move before the mint: which file to read depends
#    on the bot handle the mint returns.)
rm -rf "${PREFIX}.old"
if [ -d "$PREFIX" ]; then mv "$PREFIX" "${PREFIX}.old"; fi
mv "$NEXT" "$PREFIX"
rm -rf "${PREFIX}.old"
mv -f "/etc/seat-glue/${SEAT}.env.new" "/etc/seat-glue/${SEAT}.env"
log "code in $PREFIX, env in /etc/seat-glue/${SEAT}.env"
install -m 0644 "$here/seat-glue@.service" /etc/systemd/system/seat-glue@.service
systemctl daemon-reload
# An upgrade: a running glue keeps the old code and old token until it restarts.
if systemctl is-active --quiet "seat-glue@${SEAT}"; then
  systemctl restart "seat-glue@${SEAT}"
  log "seat-glue@${SEAT} restarted on the new code and token"
else
  log "installed. NOT started — run cutover.sh ${SEAT} to move the bot over."
fi
