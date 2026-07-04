#!/usr/bin/env python3
"""apply-bakein.py — apply the doorman-nemoclaw-setup-guide.md §6 bake-in edits
to a NemoClaw source checkout (default /home/ubuntu/.nemoclaw/source).

Usage:  python3 apply-bakein.py [SOURCE_DIR]

Idempotent: re-running skips edits that are already present.
Fail-loud: if an upstream anchor can't be found, the edit ABORTS with a pointer
to the matching manual section in doorman-nemoclaw-setup-guide.md §6 — never guesses.

Supports TWO upstream generations, auto-detected per edit (2026-07-04: NVIDIA
rewrote the config generator in TypeScript and restructured the placeholder
heredoc; the Brev-era guide describes the OLD layout):
  OLD: scripts/generate-openclaw-config.py + replacements-dict heredoc
  NEW: scripts/generate-openclaw-config.mts + replacement_patterns heredoc

The five edits (see the guide for full rationale):
  (1)  toolSearch:false manifests (nemotron + z-ai/glm-5.2)
  (2)  config generator — bake the trades-spine MCP block
  (3)  nemoclaw-start.sh — runtime badge fallback (harmless no-op normally)
  (3b) nemoclaw-start.sh — placeholder self-heal (the versioning-trap fix:
       upstream only rewrites CANONICAL placeholder tokens, so a config frozen
       to a stale v<NUM>_KEY form stays broken; this heals ANY on-disk form to
       the current generation's form on every boot)
  (4)  Dockerfile — ARG/ENV plumbing for NEMOCLAW_TRADES_SPINE_*
No edit contains a secret; the badge stays in the provider store.
"""

import json
import os
import subprocess
import sys

SRC = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/.nemoclaw/source")
GUIDE = "doorman-nemoclaw-setup-guide.md §6"

applied, skipped = [], []


def die(edit, msg):
    print(f"\n✗ edit {edit}: {msg}", file=sys.stderr)
    print(f"  The NemoClaw source has likely drifted from what this script expects.", file=sys.stderr)
    print(f"  Apply edit {edit} by hand following {GUIDE}, then re-run this script", file=sys.stderr)
    print(f"  (already-applied edits are skipped automatically).", file=sys.stderr)
    sys.exit(1)


def read(rel, edit="?"):
    p = os.path.join(SRC, rel)
    if not os.path.exists(p):
        die(edit, f"expected file missing: {p}")
    with open(p, encoding="utf-8") as f:
        return p, f.read()


def write(path, content):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


# ── (1) toolSearch:false manifests ──────────────────────────────────────────
def edit1_manifests():
    d = os.path.join(SRC, "nemoclaw-blueprint", "model-specific-setup", "openclaw")
    if not os.path.isdir(d):
        die("1", f"manifest dir missing: {d}")
    manifests = {
        "nemotron-3-super-toolsearch-off.json": {
            "$schema": "../schema.json",
            "id": "nemotron-3-super-toolsearch-off",
            "agent": "openclaw",
            "description": (
                "Nemotron-3-Super cannot drive OpenClaw code mode (tool_search_code); "
                "it hallucinates the bridge API and every tool call fails with 'run "
                "bridge code failed'. Disable toolSearch so tools — including MCP "
                "servers like trades-spine — are exposed directly as native function calls."
            ),
            "match": {"modelIds": ["nvidia/nemotron-3-super-120b-a12b"]},
            "effects": {"openclawTools": {"toolSearch": False}},
        },
        "glm-5-2-toolsearch-off.json": {
            "$schema": "../schema.json",
            "id": "glm-5-2-toolsearch-off",
            "agent": "openclaw",
            "description": (
                "z-ai/glm-5.2: whether it can drive OpenClaw code mode is UNVERIFIED "
                "(guide §6 edit 1 model note, 2026-07-02). Direct function calls are the "
                "verified-working path, so keep toolSearch off. If code mode is ever "
                "verified working for GLM-5.2, this manifest can be deleted."
            ),
            "match": {"modelIds": ["z-ai/glm-5.2"]},
            "effects": {"openclawTools": {"toolSearch": False}},
        },
    }
    for name, body in manifests.items():
        p = os.path.join(d, name)
        if os.path.exists(p):
            skipped.append(f"1:{name}")
            continue
        write(p, json.dumps(body, indent=2) + "\n")
        applied.append(f"1:{name}")


# ── (2) generator: bake the trades-spine MCP block ──────────────────────────
GEN_BLOCK_PY = '''
    # ── Trades-spine MCP server (on-host doorman badge-proxy) ─────────
    # Gated on NEMOCLAW_TRADES_SPINE_ENABLED. Writes ONLY the openshell:resolve:env
    # placeholder — the real badge is injected at runtime, never baked here.
    if _truthy_env_default(env, "NEMOCLAW_TRADES_SPINE_ENABLED", False):
        trades_url = (
            env.get("NEMOCLAW_TRADES_SPINE_URL")
            or "http://host.openshell.internal:3001/"
        )
        config.setdefault("mcp", {}).setdefault("servers", {})["trades-spine"] = {
            "transport": "streamable-http",
            "url": trades_url,
            "headers": {
                "Authorization": "Bearer openshell:resolve:env:TRADES_SPINE_BADGE",
            },
        }
'''

GEN_BLOCK_TS = '''
  // ── Trades-spine MCP server (on-host doorman badge-proxy) ─────────
  // Gated on NEMOCLAW_TRADES_SPINE_ENABLED. Writes ONLY the openshell:resolve:env
  // placeholder — the real badge is injected at runtime, never baked here.
  if (env.NEMOCLAW_TRADES_SPINE_ENABLED === "1") {
    const mcp = (config.mcp ??= {}) as JsonObject;
    const mcpServers = (mcp.servers ??= {}) as JsonObject;
    mcpServers["trades-spine"] = {
      transport: "streamable-http",
      url: env.NEMOCLAW_TRADES_SPINE_URL || "http://host.openshell.internal:3001/",
      headers: { Authorization: "Bearer openshell:resolve:env:TRADES_SPINE_BADGE" },
    };
  }
'''


def edit2_generator():
    py_path = os.path.join(SRC, "scripts", "generate-openclaw-config.py")
    ts_path = os.path.join(SRC, "scripts", "generate-openclaw-config.mts")
    if os.path.exists(py_path):  # OLD layout
        p, c = read("scripts/generate-openclaw-config.py", "2")
        if "NEMOCLAW_TRADES_SPINE_ENABLED" in c:
            skipped.append("2")
            return
        web = c.find('tools_web["search"]')
        if web == -1:
            die("2", 'anchor `tools_web["search"]` not found in generate-openclaw-config.py')
        ret = c.find("\n    return config", web)
        if ret == -1:
            die("2", "anchor `return config` not found after the tools_web block")
        write(p, c[:ret] + "\n" + GEN_BLOCK_PY.rstrip("\n") + c[ret:])
        applied.append("2 (py)")
    elif os.path.exists(ts_path):  # NEW layout (TypeScript, 2026-07)
        p, c = read("scripts/generate-openclaw-config.mts", "2")
        if "NEMOCLAW_TRADES_SPINE_ENABLED" in c:
            skipped.append("2")
            return
        web = c.find('env.NEMOCLAW_WEB_SEARCH_ENABLED === "1"')
        if web == -1:
            die("2", "anchor `env.NEMOCLAW_WEB_SEARCH_ENABLED` not found in generate-openclaw-config.mts")
        ret = c.find("\n  return config;", web)
        if ret == -1:
            die("2", "anchor `return config;` not found after the web-search block")
        write(p, c[:ret] + "\n" + GEN_BLOCK_TS.rstrip("\n") + c[ret:])
        applied.append("2 (mts)")
    else:
        die("2", "no config generator found (neither generate-openclaw-config.py nor .mts)")


# ── nemoclaw-start.sh shared helpers ─────────────────────────────────────────
def start_sh(edit):
    p, c = read("scripts/nemoclaw-start.sh", edit)
    py = c.find("PYPLACEHOLDERS")
    if py == -1:
        die(edit, "marker `PYPLACEHOLDERS` not found in nemoclaw-start.sh")
    return p, c, py


# ── (3) runtime badge fallback ───────────────────────────────────────────────
FALLBACK_BLOCK = '''# Trades-spine MCP badge fallback: if TRADES_SPINE_BADGE is in the container env,
# substitute it into the header. (The real path is OpenShell egress resolution from
# the provider store; this is a harmless no-op when the badge isn't in env.)
trades_badge = os.environ.get("TRADES_SPINE_BADGE", "")
trades_placeholder = "openshell:resolve:env:TRADES_SPINE_BADGE"
mcp_servers = updated.get("mcp", {}) if isinstance(updated, dict) else {}
mcp_servers = mcp_servers.get("servers", {}) if isinstance(mcp_servers, dict) else {}
trades_server = mcp_servers.get("trades-spine") if isinstance(mcp_servers, dict) else None
if isinstance(trades_server, dict) and isinstance(trades_server.get("headers"), dict):
    auth = trades_server["headers"].get("Authorization")
    if isinstance(auth, str) and trades_placeholder in auth:
        if not trades_badge:
            warnings.append("[mcp] trades-spine Authorization is a placeholder but TRADES_SPINE_BADGE is missing from the runtime environment")
        elif trades_badge.startswith(prefix):
            warnings.append("[mcp] trades-spine left unchanged because TRADES_SPINE_BADGE is itself an OpenShell placeholder")
        else:
            trades_server["headers"]["Authorization"] = auth.replace(trades_placeholder, trades_badge)
            refreshed.add("TRADES_SPINE_BADGE")

'''


def edit3_fallback():
    p, c, py = start_sh("3")
    if "trades_placeholder" in c:
        skipped.append("3")
        return
    anchor = c.find("\nif updated != config:", py)
    if anchor == -1:
        die("3", "anchor `if updated != config:` not found after PYPLACEHOLDERS")
    write(p, c[: anchor + 1] + FALLBACK_BLOCK + c[anchor + 1 :])
    applied.append("3")


# ── (3b) placeholder self-heal (versioning-trap fix) ─────────────────────────
# OLD layout: rewrite() iterates a replacements dict of canonical→current.
OLD_HUNK_A_OLD = '''replacements = {}
warnings = []

for key in keys:
    value = os.environ.get(key, "")
    if value.startswith(prefix) and value != f"{prefix}{key}":
        replacements[f"{prefix}{key}"] = (key, value)
'''

OLD_HUNK_A_NEW = '''warnings = []

# Map ANY on-disk form of a managed placeholder — canonical or a stale
# revision-scoped v<NUM>_KEY frozen by a previous boot — to the CURRENT
# generation's form: the runtime env's placeholder when the provider snapshot
# exposes one, else canonical (which the egress proxy resolves to current).
# A config frozen to an old provider generation therefore heals on every boot
# instead of requiring manual surgery.
heal_keys = list(keys)
if "TRADES_SPINE_BADGE" not in heal_keys:
    heal_keys.append("TRADES_SPINE_BADGE")
targets = {}
for key in heal_keys:
    value = os.environ.get(key, "")
    targets[key] = value if value.startswith(prefix) else f"{prefix}{key}"
placeholder_re = re.compile(
    re.escape(prefix)
    + r"(?:v\\d+_)?("
    + "|".join(re.escape(key) for key in heal_keys)
    + r")(?![A-Za-z0-9_])"
)
'''

OLD_HUNK_B_OLD = '''    if isinstance(value, str):
        for old, (key, new) in replacements.items():
            if old in value:
                value = value.replace(old, new)
                refreshed.add(key)
        return value
'''

OLD_HUNK_B_NEW = '''    if isinstance(value, str):
        def _heal(match):
            key = match.group(1)
            target = targets[key]
            if match.group(0) != target:
                refreshed.add(key)
            return target
        return placeholder_re.sub(_heal, value)
'''

# NEW layout (2026-07): upstream builds replacement_patterns from the same
# canonical-only replacements dict. Swap the pattern construction so each
# managed key matches canonical OR stale-versioned forms and targets the
# current generation's form; guard rewrite()'s refreshed-marking so a
# no-op replacement (canonical→canonical) doesn't churn the config hash.
NEW_HUNK_A_OLD = '''replacement_patterns = [
    (re.compile(re.escape(old) + r"(?![A-Za-z0-9_])"), key, new)
    for old, (key, new) in sorted(replacements.items(), key=lambda kv: -len(kv[0]))
]
'''

NEW_HUNK_A_NEW = '''# Heal ANY on-disk form of a managed placeholder — canonical or a stale
# revision-scoped v<NUM>_KEY frozen by a previous boot — to the CURRENT
# generation's form: the runtime env's placeholder when the provider snapshot
# exposes one, else canonical (which the egress proxy resolves to current).
# A config frozen to an old provider generation therefore heals on every boot
# instead of requiring manual surgery. TRADES_SPINE_BADGE is force-included
# so a stale versioned badge header canonicalizes even before the provider
# snapshot exposes it.
heal_keys = list(keys)
if "TRADES_SPINE_BADGE" not in heal_keys:
    heal_keys.append("TRADES_SPINE_BADGE")
heal_targets = {}
for key in heal_keys:
    value = os.environ.get(key, "")
    heal_targets[key] = value if value.startswith(prefix) else f"{prefix}{key}"
replacement_patterns = [
    (
        re.compile(re.escape(prefix) + r"(?:v[0-9]+_)?" + re.escape(key) + r"(?![A-Za-z0-9_])"),
        key,
        heal_targets[key],
    )
    for key in sorted(heal_keys, key=len, reverse=True)
]
'''

NEW_HUNK_B_OLD = '''        for pattern, key, new in replacement_patterns:
            updated, count = pattern.subn(new, value)
            if count:
                refreshed.add(key)
                value = updated
        return value
'''

NEW_HUNK_B_NEW = '''        for pattern, key, new in replacement_patterns:
            updated, count = pattern.subn(new, value)
            if count and updated != value:
                refreshed.add(key)
            value = updated
        return value
'''


def edit3b_selfheal():
    p, c, py = start_sh("3b")
    if "heal_keys" in c:
        skipped.append("3b")
        return
    head, tail = c[:py], c[py:]
    if NEW_HUNK_A_OLD in tail:  # NEW layout
        if NEW_HUNK_B_OLD not in tail:
            die("3b", "new-layout hunk B (rewrite loop) not found — upstream drifted again")
        tail = tail.replace(NEW_HUNK_A_OLD, NEW_HUNK_A_NEW, 1).replace(NEW_HUNK_B_OLD, NEW_HUNK_B_NEW, 1)
        write(p, head + tail)
        applied.append("3b (new layout)")
    elif OLD_HUNK_A_OLD in tail:  # OLD layout
        if OLD_HUNK_B_OLD not in tail:
            die("3b", "old-layout hunk B upstream text not found (the rewrite() str branch)")
        imp_old, imp_new = "import os\nimport sys", "import os\nimport re\nimport sys"
        if imp_new not in tail:
            if imp_old not in tail:
                die("3b", "heredoc import block (`import os` / `import sys`) not found")
            tail = tail.replace(imp_old, imp_new, 1)
        tail = tail.replace(OLD_HUNK_A_OLD, OLD_HUNK_A_NEW, 1).replace(OLD_HUNK_B_OLD, OLD_HUNK_B_NEW, 1)
        write(p, head + tail)
        applied.append("3b (old layout)")
    else:
        die("3b", "neither layout's placeholder-rewrite block found in the PYPLACEHOLDERS heredoc")


# ── (4) Dockerfile ARG/ENV plumbing ──────────────────────────────────────────
def edit4_dockerfile():
    p, c = read("Dockerfile", "4")
    if "NEMOCLAW_TRADES_SPINE_ENABLED" in c:
        skipped.append("4")
        return
    lines = c.splitlines(keepends=True)
    arg_i = env_i = None
    for i, ln in enumerate(lines):
        if ln.startswith("ARG NEMOCLAW_WEB_SEARCH_ENABLED") and arg_i is None:
            arg_i = i
        if "NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED}" in ln and not ln.startswith("ARG") and env_i is None:
            env_i = i
    if arg_i is None:
        die("4", "anchor `ARG NEMOCLAW_WEB_SEARCH_ENABLED` not found in Dockerfile")
    if env_i is None:
        die("4", "ENV promotion line for NEMOCLAW_WEB_SEARCH_ENABLED not found in Dockerfile")
    indent = lines[env_i][: len(lines[env_i]) - len(lines[env_i].lstrip())]
    # Insert the ENV lines BEFORE the anchor line so the `\` continuations stay
    # valid even if the anchor is the last entry of the ENV block.
    lines[env_i:env_i] = [
        f"{indent}NEMOCLAW_TRADES_SPINE_ENABLED=${{NEMOCLAW_TRADES_SPINE_ENABLED}} \\\n",
        f"{indent}NEMOCLAW_TRADES_SPINE_URL=${{NEMOCLAW_TRADES_SPINE_URL}} \\\n",
    ]
    lines[arg_i + 1 : arg_i + 1] = [
        "ARG NEMOCLAW_TRADES_SPINE_ENABLED=1\n",
        "ARG NEMOCLAW_TRADES_SPINE_URL=\n",
    ]
    write(p, "".join(lines))
    applied.append("4")


# ── run all + sanity checks ──────────────────────────────────────────────────
def main():
    if not os.path.isdir(SRC):
        print(f"✗ source dir not found: {SRC} — install NemoClaw first (bootstrap phase 'nemoclaw').", file=sys.stderr)
        sys.exit(1)
    edit1_manifests()
    edit2_generator()
    edit3_fallback()
    edit3b_selfheal()
    edit4_dockerfile()

    gen_py = os.path.join(SRC, "scripts", "generate-openclaw-config.py")
    if os.path.exists(gen_py):
        subprocess.run([sys.executable, "-m", "py_compile", gen_py], check=True)
    subprocess.run(["bash", "-n", os.path.join(SRC, "scripts", "nemoclaw-start.sh")], check=True)

    print(f"applied: {applied or 'nothing (all present)'}")
    print(f"skipped (already applied): {skipped or 'none'}")
    print("sanity: bash -n passed" + (" + py_compile" if os.path.exists(gen_py) else " (generator is .mts — validated at image build)"))
    if applied:
        print("\nNOTE: edits are in the SOURCE. They reach the sandbox image at the next")
        print("build — the first `nemoclaw onboard` on a fresh box, or `nemoclaw <AGENT>")
        print("rebuild --yes` (NVIDIA_API_KEY must be exported) on an existing one.")


main()
