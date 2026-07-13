---
date: 2026-07-12
branch: main
commit: f884a97
topic: Brave/web-search configuration surface (Feature E) — every switch, key path, egress layer, and the existing guard surface the hardening scope will audit
---

## Summary

Feature E ("web search via Brave, ALL tiers" — `thoughts/shared/build-schedule.md`) wants to turn
on web search for every sandbox agent and harden against prompt injection from web content. This
document maps what exists today. The short version: web search is a **vendor-native OpenClaw
feature that is currently switched off in three independent places** — the interactive onboard
answer ("Brave search: N"), the scripted provision path (which never supplies a Brave key), and
the image build flag (`NEMOCLAW_WEB_SEARCH_ENABLED`, present in the vendor Dockerfile but never
set to 1 by us). Our own bake-in machinery (`apply-bakein.py`) already *anchors on* the vendor's
web-search config block, so the repo knows exactly where the switch lives even though it has
never flipped it. Around the tool sit two structural layers that matter for hardening: the
sandbox's **egress allowlist** (default-deny; a standard `brave` preset exists and survives
rebuilds) and the spine's **confirm-gate surface** (4 of the 18 tools are two-step staged; 5
manager admin tools and all manager Composio executions are single-call).

## Entry Points

Where the "web search off" state is set today:

- [Box_Setup_Stuff/bootstrap-box.sh:169](../../Box_Setup_Stuff/bootstrap-box.sh#L169) — the
  onboard cheat sheet answers the wizard's `Brave search` prompt with **N**. (Note: the
  build-schedule entry cites line 148 — the file grew with the provision/recycler phases;
  the current line is 169.)
- [Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:460](../../Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md#L460)
  — §4 interactive onboard walkthrough: "Brave search **N**".
- [Box_Setup_Stuff/bootstrap-box.sh:209-288](../../Box_Setup_Stuff/bootstrap-box.sh#L209-L288) —
  `phase_provision` (every seat after the first, and every recycler rebuild): exports
  `TELEGRAM_BOT_TOKEN`, `NVIDIA_INFERENCE_API_KEY`, plan, model — **no Brave key, no web-search
  flag**, so non-interactive onboards build with search off by default.
- [Box_Setup_Stuff/apply-bakein.py:440-447](../../Box_Setup_Stuff/apply-bakein.py#L440-L447) —
  our Dockerfile edit anchors on the vendor's `ARG NEMOCLAW_WEB_SEARCH_ENABLED` line and its ENV
  promotion; we add our own flags **next to** it and leave it untouched (i.e. unset/0).

## Key Files

| File | Role for this feature |
|---|---|
| [Box_Setup_Stuff/bootstrap-box.sh](../../Box_Setup_Stuff/bootstrap-box.sh) | All build paths: `onboard-help` (L155-178, the N answer), `provision` (L209-288, scripted onboard — where a key/flag would have to enter), `wire` (L478-646, egress preset + AGENTS.md blocks — where a hardening prompt block would ship), `verify` (L709-819, incl. the credential-freshness check any new provider credential would be covered by) |
| [Box_Setup_Stuff/apply-bakein.py](../../Box_Setup_Stuff/apply-bakein.py) | The image bake-in. Knows both vendor generator layouts: OLD Python anchor `tools_web["search"]` (L154), NEW TypeScript anchor `env.NEMOCLAW_WEB_SEARCH_ENABLED === "1"` (L167) — proof the vendor generator writes the web-search config at **image build time**, gated on that env flag. Also bakes `toolSearch:false` manifests for BOTH models — nemotron (L75) and `z-ai/glm-5.2` (L88-99) |
| [Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md](../../Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md) | §4 onboard answers (L460); §4b non-interactive recipe (L468-524); §5b credential lifecycle — corrected 2026-07-11 (L591-607); §6 bake-in incl. the Dockerfile web-search anchor (L826) and the rebuild-presets note listing `brave` as a standard auto-restored preset (L850) |
| [Box_Setup_Stuff/doorman-architecture-memory.md](../../Box_Setup_Stuff/doorman-architecture-memory.md) | Architecture mental model. ⚠ Two sections are STALE (see Constraints): the per-request credential substitution claims (L118-124, L231-236) contradict the guide's 2026-07-11 correction, and "manifest is currently Nemotron-only" (L151-164) predates apply-bakein.py's GLM manifest |
| [src/mcp/server.ts](../../src/mcp/server.ts) | The 18-tool spine surface the hardening audit enumerates (tool defs L110-393; `ADMIN_TOOL_NAMES` dispatch gate L404-406; `AUDIT_CHANNELS` L408-415) |
| [docs/nemoclaw-tech-agent.md](../../docs/nemoclaw-tech-agent.md) | §4 tool-surface restriction — the OpenClaw technician-profile allowlist precedent (`get_schedule` had to be named there or the agent couldn't call it); §7 Composio tiering + the credential-lifecycle summary (L190-201) |
| [Box_Setup_Stuff/doorman.mjs](../../Box_Setup_Stuff/doorman.mjs) (embedded in guide §3c) | Not in the web-search path at all — web search would be the first agent capability that does NOT transit the doorman |
| [thoughts/shared/build-schedule.md](../build-schedule.md) | The Feature E entry: decisions already made (all tiers, one shared key, no tier gating) + hardening scope |

## Data Flows

### How web-search config reaches a sandbox (if enabled)

The vendor generator runs at **image build time** (Dockerfile `RUN … generate-openclaw-config`),
rendering `/sandbox/.openclaw/openclaw.json` — the same mechanism our trades-spine block rides:

```
Dockerfile ARG NEMOCLAW_WEB_SEARCH_ENABLED=1        (never set by us today)
        │  promoted to ENV at build
        ▼
scripts/generate-openclaw-config.mts                (on the box, not in this repo)
  if (env.NEMOCLAW_WEB_SEARCH_ENABLED === "1") {…}  ← apply-bakein.py:167 anchors here
        │  renders at image build
        ▼
/sandbox/.openclaw/openclaw.json                    (container writable layer;
  tools.web.search.* / plugins.entries.brave.*       recreate wipes → bake-in exists)
        │  read at openclaw process start
        ▼
web_search tool exposed to the agent
        │  each call
        ▼
OpenShell egress proxy — allowlist check            (standard `brave` preset;
        ▼                                            auto-restored on rebuild)
api.search.brave.com  (Brave Search API, keyed)
```

Two vendor generator generations exist; `apply-bakein.py` handles both
([apply-bakein.py:146-176](../../Box_Setup_Stuff/apply-bakein.py#L146-L176)): OLD layout =
`generate-openclaw-config.py` with a `tools_web["search"]` block; NEW layout (2026-07, current on
trades-box-1) = `generate-openclaw-config.mts` gated on `NEMOCLAW_WEB_SEARCH_ENABLED === "1"`.
The exact JSON the vendor block renders is only readable on the box (the generator is not in this
repo) — see Open Questions.

There is also a second, non-baked route used elsewhere in this stack: direct edit of the rendered
`openclaw.json` + recompute `/sandbox/.openclaw/.config-hash` + chmod 660 + `nemoclaw <ref>
gateway restart` — the no-rebuild reconcile path proven by Feature A's `apply-binding.sh`
([doorman-architecture-memory.md:85-99](../../Box_Setup_Stuff/doorman-architecture-memory.md#L85-L99)).
Relevant because a rebuild carries the device-key-strip hazard
(`nemoclaw-rebuild-strips-device-key`), so live seats (s1-s3) have a known config-edit path that
avoids it.

### How the Brave API key could reach the process (three observed mechanisms, none exercised for Brave)

1. **Attached-provider credential** (how `TELEGRAM_BOT_TOKEN` and `TRADES_SPINE_BADGE` travel):
   registered into the openclaw process env at **process launch only** as a version-scoped
   placeholder; the real value resolves **in-process at component init** against the provider
   store. Every credential write after launch needs a container restart
   ([setup guide §5b, corrected 2026-07-11](../../Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md#L591-L607)).
   Whether OpenClaw's web-search plugin resolves `openshell:resolve:env:` placeholders the way
   the Telegram bridge and MCP connect do is **unverified** — noted upstream that the
   streamable-http MCP loader does NOT itself resolve them
   ([doorman-architecture-memory.md:123-124](../../Box_Setup_Stuff/doorman-architecture-memory.md#L123-L124)).
2. **Plain env var**: OpenClaw reads `BRAVE_API_KEY` from the gateway/process environment
   (vendor docs — see External Dependencies).
3. **Config field**: `plugins.entries.brave.config.webSearch.apiKey` in openclaw.json (vendor
   docs). Note the repo's standing rule that secrets never go into image/config
   (bootstrap-box.sh header L27-29; the NVIDIA key leak is the recorded counter-example).

### The existing guard surface web content would land inside (hardening-audit baseline)

18 spine tools ([src/mcp/server.ts:110-393](../../src/mcp/server.ts#L110-L393)); tier filtering
and re-gating at dispatch are server-side (`ADMIN_TOOL_NAMES`, L404-406). Enumerated by guard
type:

| Guard | Tools |
|---|---|
| Two-step stage→confirm (server refuses to act without a confirmed token) | `record_field_note`, `send_email`, `retract_capture`, `deactivate_technician_seat` |
| Single-call, state-changing, **no confirm token** (manager-only by tier gate) | `add_technician_seat`, `reactivate_technician_seat`, `get_connect_link` (mints a SENSITIVE pairing link; 5-min cooldown), `bind_telegram` (rebinding claims/repoints a sandbox), `resolve_review` (can activate a person or tear down a pairing) |
| Read-only | `find_customer`, `get_customer_context`, `get_job`, `list_recent_captures`, `brief_customer`, `answer_customer_question`, `get_schedule`, `list_team`, `list_pending_reviews` |
| Prompt-layer only (explicit user decision 2026-07-04: "no structural block on destructive tools") | ALL manager-tier Composio executions — full catalog, confirmations live in the §0b instruction block ([setup guide L71-80](../../Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md#L71-L80)) |

Prompt-layer blocks in every sandbox's workspace `AGENTS.md` (§0c accuracy + permanent-record,
§0d batching — appended by `bootstrap-box.sh wire`, wiped by any rebuild, re-appended by `wire`):
[bootstrap-box.sh:512-628](../../Box_Setup_Stuff/bootstrap-box.sh#L512-L628). A web-content
hardening block (build-schedule direction 5) would ship in this same phase and lifecycle.

Audit trail: outbound/agent actions land in L1 classifier-free (`outbound_email` verbatim,
`agent_action` keys-only, manager-only sensitivity; permission-gate rejections are NOT logged —
[docs/nemoclaw-tech-agent.md:207-213](../../docs/nemoclaw-tech-agent.md#L207-L213), L255-258).
Web searches would be the agent's first outbound action class with no L1 story either way (the
Excel-reads exclusion is the nearest precedent).

## External Dependencies

All vendor claims below were pulled from live docs on 2026-07-12 (per the CLAUDE.md
external-services rule); the repo previously contained **zero** citations on OpenClaw web-search
behavior.

- **OpenClaw web tools** (https://docs.openclaw.ai/tools/web): three tools — `web_search`
  (provider-backed, results cached 15 min), `x_search`, and **`web_fetch`** ("lightweight URL
  fetching", "always runs locally"). `web_search` config: `tools.web.search.enabled`
  (**default: true**), `.provider`, `.maxResults`, `.timeoutSeconds`, `.cacheTtlMinutes`.
- **`web_fetch`** (https://docs.openclaw.ai/tools/web-fetch): **enabled by default**
  (`tools.web.fetch.enabled: true`); disable key `tools.web.fetch.enabled: false`. Has its own
  SSRF guard (blocks private/internal hostnames, re-checks redirects; `ssrfPolicy.*` opt-ins for
  proxy ranges). No prompt-injection warning in the vendor docs. So the vendor default posture,
  if we enable the web toolset, is **search + arbitrary-public-URL fetch together** — the
  search-only-vs-search+fetch split the build-schedule entry asks about is a real config choice
  (`tools.web.fetch.enabled: false`), not the default.
- **Brave provider config** (https://docs.openclaw.ai/tools/brave-search): canonical path
  `plugins.entries.brave.config.webSearch.*` — `.apiKey`, `.mode` (`web` = title/URL/snippet
  results, default; `llm-context` = Brave's pre-extracted grounding chunks), `.baseUrl`. Key via
  `BRAVE_API_KEY` env or the config field. Legacy `tools.web.search.apiKey` deprecated. Brave is
  OpenClaw's default `web_search` provider.
- **Brave Search API** (https://api-dashboard.search.brave.com/documentation/pricing, verified
  2026-07-11 in the build-schedule entry): Web Search $5.00/1,000 requests, $5 free monthly
  credits, 50 req/s; card required since ~Feb 2026; overages have no spending cap.
- **OpenShell egress layer**: default-deny per-sandbox network policy; standard presets
  (`npm/pypi/huggingface/brew/brave/openclaw-pricing/telegram`) are auto-restored by the rebuild
  flow — custom presets (like `trades-spine-doorman`) are NOT
  ([setup guide L850](../../Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md#L850),
  [doorman-architecture-memory.md:203-204](../../Box_Setup_Stuff/doorman-architecture-memory.md#L203-L204)).
  What hosts the `brave` preset actually allowlists is on-box state (`nemoclaw <AGENT>
  policy-list`), not in the repo.

## Constraints and Invariants

- **Web search bypasses the doorman entirely.** Every existing agent capability transits
  doorman→Render (identity, tier, audit). `web_search`/`web_fetch` would go sandbox→egress
  proxy→internet directly — the first capability outside that chokepoint. The only structural
  controls on it are the sandbox's own config and the egress allowlist.
- **The egress allowlist is the outer boundary for fetch.** Even with `web_fetch` enabled in
  openclaw.json, the OpenShell egress proxy default-denies hosts not in an applied preset
  (observed behavior: the doorman needed its own preset with explicit RFC1918 allowances). What
  arbitrary-URL fetch would actually be *able* to reach depends on the on-box preset set — see
  Open Questions.
- **Config lifecycle rules that apply to any web-search enablement:** the rendered
  `openclaw.json` is writable-layer (recreate wipes it → bake-in); direct edits need the
  `.config-hash` recompute + 660 + gateway restart (Feature A pattern); rebuilds risk the
  device-key strip (back up identity first); credentials in attached providers take effect only
  at container restart.
- **toolSearch is `false` on both model manifests now** — `apply-bakein.py` bakes
  `glm-5-2-toolsearch-off.json` alongside the Nemotron one
  ([apply-bakein.py:88-99](../../Box_Setup_Stuff/apply-bakein.py#L88-L99)), so tools are exposed
  as direct function calls. Whether `web_search`/`web_fetch` appear on that direct-function
  surface for GLM-5.2 is unverified (same class of question as `get_schedule`'s allowlist
  gotcha).
- **A per-profile tool allowlist exists and has bitten before**: `get_schedule` was invisible to
  agents until named in the OpenClaw technician profile allowlist
  ([setup guide L24](../../Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md#L24),
  [docs/nemoclaw-tech-agent.md §4](../../docs/nemoclaw-tech-agent.md)). New web tools would face
  the same requirement on any sandbox with a pinned list.
- **Doc drift found during this research** (document-only; no action taken):
  1. `doorman-architecture-memory.md` L118-124 and L231-236 still claim per-request egress
     substitution / "value swap needs no restart" — contradicted by the setup guide's 2026-07-11
     credential-lifecycle correction (L591-607) and `docs/nemoclaw-tech-agent.md` L190-201. The
     guide is the corrected source; the memory doc is stale.
  2. Manager tool count: guide §0 (L24) says 17 and omits `bind_telegram`;
     `docs/nemoclaw-tech-agent.md` §4 says 18 (8 admin tools); `src/mcp/server.ts` defines 18.
  3. The build-schedule Feature E entry cites `bootstrap-box.sh:148` for the onboard answer;
     it is line 169 at commit f884a97.
- **Decisions already recorded in the build-schedule entry (not re-opened here):** all tiers,
  one shared platform key, no tier gating; Composio-relay alternative mooted; usage alert
  required (no spend cap).

## Decision Points

Stated factually — what the fork is and what each side involves given today's code:

1. **Which enable mechanism, per seat class.** (a) *Bake-in flag* — set
   `NEMOCLAW_WEB_SEARCH_ENABLED=1` (Dockerfile ARG/ENV, one more `apply-bakein.py`-style edit or
   just flipping the vendor ARG): every future build/rebuild comes up with search on; does
   nothing for the three live sandboxes until they rebuild (device-key-strip hazard). (b)
   *No-rebuild config edit* on live seats — the Feature A reconcile pattern (openclaw.json +
   config-hash + 660 + gateway restart); survives restarts, wiped by a recreate until a rebuild
   bakes it. (c) *Onboard answer flip* ("Brave search Y") — only affects interactive onboards;
   the scripted `provision` path doesn't ask, so it would ALSO need the flag/key in its env
   (bootstrap-box.sh L235-237's `--preserve-env` list). A full rollout touches all three.
2. **How the key travels.** Provider-credential placeholder (matches every other sandbox secret;
   restart-to-take-effect; but placeholder resolution by the web-search plugin is unverified) vs
   plain `BRAVE_API_KEY` env at process launch (vendor-documented; how it enters the launch env
   on this stack is the open wiring question) vs config-field `apiKey` (vendor-documented;
   conflicts with the no-secrets-in-config rule this stack otherwise maintains).
3. **`web_fetch` posture.** Vendor default is ON alongside search. Options as the code stands:
   leave it on and rely on the egress allowlist as the outer boundary (contents of the `brave`
   preset unverified); or set `tools.web.fetch.enabled: false` for a snippets-only surface
   (`webSearch.mode: "web"`), which is the smaller injection/exfil surface the build-schedule
   entry describes. `llm-context` mode is a middle shape: larger text chunks, still
   Brave-API-host-only.
4. **Tool allowlist updates.** Any sandbox profile with a pinned tool list needs
   `web_search` (and `web_fetch`, if chosen) named, or the tool is silently absent — the
   `get_schedule` precedent. Which sandboxes actually carry pinned lists today is on-box state.
5. **Confirm-gate coverage under adversarial input.** The audit baseline above shows exactly
   where single-call state changes live: 5 manager admin tools on the spine + all manager
   Composio executions (prompt-gated by explicit decision). Extending stage→confirm to any of
   them is a server-side change with an existing pattern (`deactivate_technician_seat`); leaving
   them as-is preserves the 2026-07-04 frictionless-manager decision. The trade-off is the
   user-facing decision the build-schedule entry flags.
6. **L1 treatment of searches.** No code path exists either way today. Nearest precedents:
   Excel READS excluded from L1 (user decision, `composio-doorman-relay`); outbound *actions*
   captured classifier-free with keys-only redaction (`src/composio/logIngest.ts` pattern).
   Searches don't transit any of our infrastructure (no doorman hop), so capturing them would
   require a new mechanism entirely; excluding them requires only recording the decision.

## Open Questions

Resolvable only on the box or by live test, not from this repo:

1. **What the vendor generator actually renders** when `NEMOCLAW_WEB_SEARCH_ENABLED=1` — which
   exact keys (`tools.web.search.*`? `plugins.entries.brave.*`? both?) and whether it also
   renders fetch config. Read `~/.nemoclaw/source/scripts/generate-openclaw-config.mts` on
   trades-box-1 around the `NEMOCLAW_WEB_SEARCH_ENABLED` block.
2. **What the interactive onboard's "Brave search Y" path does** — whether it prompts for a key,
   where it stores it (credential store? provider? Dockerfile ARG?), and whether it applies the
   `brave` egress preset conditionally.
3. **What hosts the standard `brave` egress preset allowlists** (`nemoclaw <AGENT> policy-list`
   / preset inspection on the box) — determines whether the egress layer alone confines an
   enabled `web_fetch`, and whether it's already applied to sandboxes where search is off.
4. **Whether the web-search plugin resolves `openshell:resolve:env:` placeholders** at component
   init (as the Telegram bridge and MCP connect do) — decides if the provider-credential path
   works for `BRAVE_API_KEY`, or only a real env value does.
5. **Whether `web_search`/`web_fetch` surface as direct function calls under `toolSearch:false`
   with GLM-5.2**, and whether the deployed sandboxes carry pinned tool allowlists that would
   hide them.
6. **Whether NemoClaw's non-interactive onboard forwards arbitrary env** (it demonstrably reads
   `TELEGRAM_BOT_TOKEN` from its process env — does the same hold for `BRAVE_API_KEY` /
   `NEMOCLAW_WEB_SEARCH_ENABLED` at build time?).
