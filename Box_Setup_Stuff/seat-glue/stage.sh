#!/usr/bin/env bash
# stage.sh <outdir> — assemble the seat glue's deployable package.
#
# The code lives in src/seatGlue (TypeScript, typed and tested with the rest of
# the repo); what ships is the compiled dist/seatGlue/*.js next to this
# directory's package.json, which pins @github/copilot-sdk and nothing else.
# The SDK is deliberately NOT in the repo's root package.json: Render installs
# that on every build and would download the engine binary for nothing.
#
#   Box_Setup_Stuff/seat-glue/stage.sh /tmp/sg
#   (cd /tmp/sg && npm ci && node app/main.js --selfcheck)   # laptop: darwin engine
#   scp -r /tmp/sg tradesbox:/tmp/seat-glue-stage            # box: then install.sh
set -euo pipefail
out="${1:?usage: stage.sh <outdir>}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

(cd "$root" && npm run build >/dev/null)

rm -rf "$out/app"
mkdir -p "$out/app"
cp "$here/package.json" "$here/package-lock.json" "$out/"
for f in install.sh cutover.sh rollback.sh seat-glue@.service; do
  [ -f "$here/$f" ] && cp "$here/$f" "$out/"
done
# The compiled glue, minus its tests (they import vitest and ../mcp, which do not ship).
for js in "$root"/dist/seatGlue/*.js; do
  case "$js" in *.test.js) continue ;; esac
  cp "$js" "$out/app/"
done
echo "staged $(ls "$out/app" | wc -l | tr -d ' ') modules into $out"
