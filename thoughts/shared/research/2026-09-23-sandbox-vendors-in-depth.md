---
date: 2026-09-23
branch: work/step-2-manager-seat-s2-on-the-seat-glue
commit: 02b0228
topic: Sandbox vendors for the manager seat (step 2) — the whole field, in depth, against live docs
supersedes: nothing (replaces §8 "sandbox vendors" of thoughts/shared/research/2026-09-21-seat-runtime-direction-openrouter-agent-sdk.md and Decision Point 1 of thoughts/shared/research/2026-09-23-step-2-manager-seat-on-the-seat-glue.md, both of which treated three vendors as the field)
---

# Sandbox vendors for the manager seat — the whole field

## Summary

A **sandbox** here is a small, isolated computer that runs code our AI agent writes — for the
manager seat, Python that turns the firm's data into an invoice PDF or a spreadsheet — so that
untrusted, model-written code never runs on the box that holds our secrets. Step 2 of the openclaw
retirement needs one sandbox per manager, driven from the seat glue (a Node process on the AWS
Lightsail box), holding files across days, and surviving the moment the sandbox goes to sleep in
the middle of a job (the step's gate). Earlier documents named three vendors — Google, Vercel,
E2B — but **that list was never the operator's choice** (operator, 2026-09-23): it came from an
aside in the 2026-09-21 research. This document surveys the field as it stands on 2026-09-23:
eleven products researched in depth, about thirty screened, and the "no vendor" option of running
sandboxes on our own box. Every fact comes from the vendor's live documentation (URL cited) unless
marked as a community report or an inference. The single most important fact: **vendors differ
most on what happens when a sandbox goes idle** — some freeze it with memory intact, some keep only
the disk, some keep nothing, and some never sleep and bill the whole time — and that is exactly
what the gate tests.

Research method: seven parallel research agents, each answering the same 16-question list
(lifecycle, addressing, commands, files, images, network, Node SDK, auth from a plain VM, limits,
pricing with a worked example, reliability, observability, the gate, gotchas). Evidence labels:
**[D]** documented by the vendor, **[C]** community report / GitHub issue, **[I]** inference.

## Where the field stands in the record

- 2026-09-21, operator (quoted, `docs/engineering-memory.md:1614`): *"I'm fine with hosting
  sandboxes for managers in the box. But technicians should probably stay thin."*
- Same night, recorded without the operator's words (`docs/engineering-memory.md:1615`):
  *"later that night the sandboxes moved to a VENDOR on demand so the box stays container-free."*
- 2026-09-21 research §8 named Google Code Execution / Vercel Sandbox / E2B (E2B "not checked").
  The task record (`.claude/work/tasks/20260923-step-2-…md`, Notes) and the memory
  `openclaw-retirement-plan` carried that list as the decision's options; the memory line was
  corrected on 2026-09-23. The task record's Notes still carry the list (shared live record, not
  edited here).
- Step 5 of the retirement plan removes the Docker sandboxes from the box; its gate is "the box
  runs three units: engine, glue, box-report" (memory `openclaw-retirement-plan`).

## The use case every vendor was measured against

```
Manager ─Telegram─► seat glue (Node, Lightsail box) ─► Copilot engine ─► Gemini (OpenRouter)
                         │  run_command / read_file / write_file / share_file
                         ▼
                 ONE sandbox per manager (id stored)  ── Python: openpyxl, reportlab, pandas
                         │  skills folder (our scripts), scratch files kept for days
                         ▼
                 PDF / XLSX pulled out ─► glue ─► Telegram document
```

Bursty load: a few minutes of compute per job, then idle for hours or days; a manager may leave an
approval waiting for minutes or hours. No credential may live in the sandbox. Must-haves used for
the screen: **M1** drivable from a Node process on a non-vendor Linux VM; **M2** files survive an
idle period of hours to days in the same sandbox (or a documented restore); **M3** Python with
openpyxl + reportlab available; **M4** addressable by a stored id.

## Entry Points

(External research — the entry points are the vendors' control APIs. The repo side is mapped in
`2026-09-23-step-2-manager-seat-on-the-seat-glue.md`.)

| Product | Node entry | Reconnect call |
|---|---|---|
| E2B | npm `e2b` 2.51.0 | `Sandbox.connect(sandboxId)` |
| Daytona | npm `@daytona/sdk` 0.216.1 (renamed from `@daytonaio/sdk`) | `daytona.get(idOrName)` then `start()` |
| Vercel Sandbox | npm `@vercel/sandbox` 3.5.0 | `Sandbox.get({name})` (auto-resumes) |
| Fly Sprites | npm `@fly/sprites` 0.2.3 (Node ≥ 24) | by sprite name; wakes on request |
| Fly Machines | REST `api.machines.dev` (no official Node SDK) | app + machine id; `start` then `wait` |
| Modal | npm `modal` 0.10.1 (JS SDK **beta**) | `Sandbox.fromId` (running only) |
| Northflank | npm `@northflank/js-client` 0.11.0 | project + service id; `resume` |
| Google Agent Platform | npm `@google-cloud/agentplatform` 0.12.0 (CommonJS; no bash helper) | resource name; `resumeInternal` |
| AWS AgentCore | npm `@aws-sdk/client-bedrock-agentcore` 3.1138.0 | interpreter id + sessionId / runtime ARN + runtimeSessionId |
| Azure dynamic sessions | REST only (no Node data-plane SDK) | pool endpoint + caller-chosen identifier |
| Cloudflare Sandbox | runs inside a Worker only; from our VM = HTTP to a "bridge" Worker we deploy | bridge `{id}` |

## Key Files

Evidence and scratch downloads (vendor doc dumps, SDK source) are in the session scratchpad
`…/8ece839d-…/scratchpad/` (`gcp/`, `e2b/`, `dt/`, `sp/`, `nf/`, `cf-sandbox.txt`,
`cf-containers.txt`, `vendor-questions.md`). Nothing in the repo changed.

## Data Flows

### The gate, per idle behaviour

What the gate asks: *job starts → sandbox goes idle and sleeps mid-job → two hours later the agent
calls `read_file` on the output.* The products fall into four idle behaviours:

```
A. FREEZE WITH MEMORY      idle ─► paused (RAM + disk + processes saved) ─► request ─► resumed, job continues
B. KEEP THE DISK ONLY      idle ─► stopped (disk saved, processes killed) ─► request ─► fresh boot on old disk
C. NEVER SLEEPS            stays running (and billed) until a TTL/timeout ─► then deleted
D. KEEPS NOTHING           idle ─► destroyed ─► request ─► NEW EMPTY sandbox (sometimes silently, same id)
```

| Product | Behaviour | What makes the gate pass | Evidence |
|---|---|---|---|
| **E2B** | **A**, only if configured — the DEFAULT is D (`onTimeout:'kill'`) | create with `lifecycle:{onTimeout:'pause', autoResume:true}`; store `sandboxId`; `Sandbox.connect(id)` (~1 s resume) then `files.read`. Pause ≈ 4 s/GiB RAM. If the node refuses the memory snapshot (~2 min), falls back to disk-only pause ("rolling out") | [D] docs.e2b.dev/sandbox/persistence, /auto-resume, /faq/sandbox-lifetime |
| **Daytona — VM class** | **A** (pause since v0.190.0, Jun 2026; auto-pause since Jul 2026, default 60 min) | `autoPauseInterval`; glue calls `get` → `start()` (no documented auto-resume on a toolbox call) → `downloadFile` | [D] daytona.io/docs/en/persistence.md, /sandboxes.md |
| **Daytona — container class (default)** | **B** (auto-stop 15 min; archived after 7 days) | glue calls `start()`; archived needs restore | [D] same; [C] #4632 archived → 404 |
| **Fly Sprites** | **A then B** — warm after ~30 s idle (memory kept, 100–500 ms), later cold at an undocumented time (memory dropped, 1–2 s); disk always kept | `GET fs/read` auto-wakes; a silent job pauses after ~30 s unless registered as a Task (heartbeat, 1 h per renewal) | [D] docs.sprites.dev/concepts/lifecycle, /keeping-sprites-running |
| **Vercel Sandbox** | **B** — session timeout is WALL-CLOCK (default 5 min, max 24 h Pro / 45 min Hobby); filesystem snapshotted at stop; processes die | `getOrCreate({name, snapshotExpiration ≥ gap})`; any SDK call auto-resumes (p75 < 1 s, p95 < 10 s); expired snapshot → silently re-created EMPTY | [D] vercel.com/docs/sandbox/concepts/persistent-sandboxes, /snapshots |
| **Fly Machines** | **B** (stop; rootfs reset unless `persist_rootfs`) or **A** (suspend, discouraged > 2 GB RAM, snapshot "not guaranteed to persist") — never sleeps on its own | files on a Volume (single host, not replicated); glue does `start` → `wait` → `exec cat` (no file API) | [D] fly.io/docs/reference/suspend-resume, /volumes/overview |
| **Northflank** | **B** for volumes only — pause wipes ephemeral storage; never sleeps on its own (bills until paused) | write outputs to a mounted volume; `resume` → poll → `download.service.files` (tar over exec) | [D] northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes.md |
| **AWS AgentCore Runtime** | **B** for the session-storage mount only (preview; wiped on every runtime version update and after 14 idle days) | write everything under the mount; same `runtimeSessionId` re-provisions | [D] AgentCore devguide runtime-filesystem-configurations |
| **Google Shell sandbox (GA 2026-09-09)** | **B**-ish — explicit pause keeps the filesystem; memory/processes across pause not documented; never auto-pauses | glue calls `:pause` itself; later `get` → `:resume` → poll → exec. No file API (files through stdout) | [D] …/scale/sandbox/manage-sandboxes, /shell-sandbox-quickstart |
| **Google Code Execution (Preview)** | **C** — no sleep; memory kept between calls; TTL up to 14 days reset per call; billed while it exists | keep calling within the TTL | [D] …/code-execution-overview |
| **AWS AgentCore Code Interpreter** | **C** — `sessionTimeoutSeconds` is a HARD TTL "regardless of ongoing activity" (default 15 min, max 8 h); no pause | set TTL ≥ gap (≤ 8 h) and pay memory the whole time; beyond 8 h, outputs must go to S3/EFS | [D] APIReference API_StartCodeInterpreterSession |
| **Modal** | **D** — idle/timeout → Finished; nothing but a mounted Volume survives (Volumes v2 is beta, "cannot yet guarantee that no data will be lost") | mount a per-manager Volume; glue detects the dead sandbox and creates a new one on the same Volume | [D] modal.com/docs/guide/sandbox, /volumes |
| **Azure dynamic sessions** | **D** — deleted after the cooldown (300–3600 s); a later call with the same id SILENTLY gets a new empty session | keepalive request inside every cooldown ($0.03/h), or copy outputs out after every call | [D] learn.microsoft.com/…/container-apps/session-pool, /sessions-usage |
| **Cloudflare Sandbox** | **D** — after `sleepAfter` (default 10 min) "All files are deleted"; next request gets a fresh container behind the same id | keepAlive (~$55/manager/month) or persist/restore to R2 before every sleep (backup restore bug #884 ≥ 10 MB); disk snapshots still "coming soon" | [D] developers.cloudflare.com/sandbox/concepts/sandboxes, /containers/platform-details/architecture |
| **No vendor (our box)** | whatever the glue decides: `docker stop` = B, `docker pause` = A with RAM still resident, gVisor `runsc checkpoint` = A to disk | files on the box's 320 GB disk | [D] docs.docker.com, gvisor.dev (see below) |

### Moving a file out (the invoice PDF)

| Product | Read a 5 MB file | Limit |
|---|---|---|
| E2B | `files.read(p, {format:'bytes'})`; pre-signed URLs | per-file ND; disk 10 / 20 GiB |
| Daytona | `downloadFile` / `downloadFileStream`; pre-signed URLs | ND |
| Vercel | `readFileToBuffer` / `downloadFile` | ND |
| Fly Sprites | `GET fs/read` raw bytes | ND |
| Modal | `copyToLocal` | read ≤ 5 GB |
| Northflank | tar over exec (image needs `tar`) | ND |
| Google Code Exec | returned inline in the execute response | 100 MB per call |
| Google Shell / Fly Machines | no file API — base64 through stdout | ND |
| AWS Code Interpreter | `readFiles` blob | 100 MB payload |
| Azure code interpreter | `GET /files/{name}/content` | upload 128 MB |
| Cloudflare (bridge) | `GET /file/*` | write 32 MiB |

## External Dependencies

### Screen: every product against the four must-haves

| Product | M1 Node on our VM | M2 files survive idle | M3 openpyxl + reportlab | M4 stored id | Note |
|---|---|---|---|---|---|
| E2B | Y | Y (with `onTimeout:'pause'`) | openpyxl in code-interpreter template; reportlab via pip or custom template | Y | default kills |
| Daytona | Y | Y | install (not preinstalled) | Y | memory kept on VM class only |
| Vercel | Y (needs a Vercel project + token) | Y (disk) | install (not in universal image [C #321]) | Y (name) | |
| Fly Sprites | Y (Node ≥ 24) | Y (disk always) | preinstalled ND; installable | Y (name) | API "v001-rc48" |
| Fly Machines | REST only | Y (Volume) | your image | Y | no file API |
| Modal | Y (JS SDK beta) | via Volume only | your image | running only | |
| Northflank | Y | via volume only | your image | Y | API 1,000 req/h |
| Google Code Exec | REST / CJS SDK | Y (≤ 14 days, billed) | **preinstalled; no installs, no network** | Y | Preview |
| Google Shell | REST / CJS SDK | Y (explicit pause) | shell image ND; pip needs egress | Y | no file API |
| AWS Code Interpreter | Y | **N** beyond 8 h TTL (needs S3/EFS) | preinstalled | Y | hard TTL |
| AWS AgentCore Runtime | Y | Y (preview mount) | your ARM64 image | Y | wiped on version update |
| Azure dynamic sessions | REST only | **N** (deleted after ≤ 1 h idle) | not documented | Y | silent new session |
| Cloudflare | **only via a Worker we deploy** | **N** by default | your image | Y | snapshots "coming soon" |
| Runloop | Y | suspend = **Pro plan $250/mo** | install | Y | |
| Blaxel (acq. Baseten 2026-09-10) | Y | Y (standby ~15 s idle, memory kept); expiry 7 d Tier 0 / 30 d Tier 1 | install | Y | |
| Freestyle | Y | `persistent` type needs $50/mo plan; exec max 5 min | install | Y | |
| Upstash Box | Y | Y (files, not memory) | Y | Y | |
| Together CodeSandbox | Y | memory 7 d, disk 2 wk, then archive | install | Y | |
| Tensorlake | Y | Y (named sandboxes) | install | Y | |
| Novita | Y | Y (pause keeps memory) | install | Y | 24 h session cap |
| Hopx | Y | unclear (timeout destroys) | install | Y | |
| Namespace, OpenComputer, Superserve | Y | Y / probably | install | Y | thin docs |
| Morph Cloud | Y | Y | install | Y | changelog stale since 2024-11; SDK last 2025-10 |
| Beam, InstaVM, Koyeb | Y | **N** in place | Y | partial | |
| Leap0 | Y | partial | — | **N** (restore = new id) | preview |
| AWS Lambda MicroVMs (Jun 2026) | Y | **N** — 8 h total cap counts suspended time | your image | Y | no run/file API |
| Anthropic code execution tool | **N** — driven only by a Claude model | — | preinstalled | — | we run Gemini |
| OpenAI Code Interpreter / hosted sandboxes | **N** | **N** (20 min / 1 h idle) | — | — | |
| Riza hosted | shut down 2025-10-01 | | | | |
| Replit | no general sandbox API | | | | |
| Azure Container Apps **Sandboxes** (`SandboxGroups`) | Python SDK only | suspend + snapshots + volumes [D] | ND | ND | **not researched in depth** — Azure's own docs steer stateful agent workspaces here |

### The deep-dive products, side by side

| | Isolation | Compliance | Regions / data | Node SDK health | Auth from our VM | Status |
|---|---|---|---|---|---|---|
| **E2B** | Firecracker microVM | SOC 2 II; HIPAA BAA Enterprise | GCP us-west1 (EU/APAC Pro+ via support); one region per key | ~2.5 releases/wk; CJS+ESM; open issues on stdout after resume (#1587, #1352), past file loss after repeat resume (#884) | one API key, any host; no scopes | GA; volumes private beta |
| **Daytona** | container (namespaces, root) or VM | SOC 2 II (2026-07); HIPAA attestation | us, eu; BYOC regions | package renamed; 26 deps; open race: auto-stop despite refreshed activity (#5154) | scoped, expiring keys — but ANY org key can run commands in ANY sandbox | GA; server went closed-source 2026-06 |
| **Vercel** | Firecracker microVM | SOC 2 II (Vercel); BAA Pro+ (sandbox scope unverified) | 19 regions, default iad1; snapshots region-locked | v3 major in Aug; several releases/wk | access token + team id + project id; project-scoped token, expiry set | GA 2026-01-30; persistence GA 2026-05-26 |
| **Fly Sprites** | Firecracker | Fly SOC 2 II (Sprites scope ND) | region not selectable [C] | 0 open issues; Node ≥ 24 | org-wide token | API "rc48"; **pricing/plans change 2026-10-01** |
| **Fly Machines** | Firecracker | same | per app/region; volume on one host | no official SDK | macaroon tokens, command-scoped exec tokens; default 20-year expiry | GA |
| **Modal** | gVisor | SOC 2 II; HIPAA Enterprise | us-east default; region pin 1.15–1.75× price | JS SDK beta, repo moved 2026-07 | token id+secret; least-privilege service users Team+ ($250/mo) | GA; memory snapshots alpha |
| **Northflank** | Kata/CLH or Firecracker microVM | SOC 2 II; HIPAA Enterprise | region fixed per project | CJS, repo not public | RBAC-scoped JWTs with expiry | GA |
| **Google** | "secure container sandboxing" (likely gVisor on GKE [I]) | Agent Platform on BAA list (pre-GA scope ND) | 24 regions | thin: pause/resume named `*Internal`, no bash helper | service-account key (blocked by default in orgs made after 2024-05-03) or workload identity federation | Shell GA 2026-09-09; Code Exec Preview |
| **AWS AgentCore** | microVM per session | SOC 1/2/3, HIPAA eligible | 9+ regions | daily AWS SDK train | IAM keys or IAM Roles Anywhere (Lightsail has no instance role) | CI GA; session storage preview |
| **Azure dynamic sessions** | Hyper-V per session | Azure-wide (sessions scope unverified) | 40+ regions | no data-plane SDK | Entra service principal; token reaches every session in the pool | data-plane API is `-preview` |
| **Cloudflare** | VM per sandbox | Containers NOT in SOC 2 scope list | placement by region/jurisdiction | stable deprecating; 1.0 preview differs; bridge not on 1.0 | one shared bridge key for all sandboxes (auth skipped if unset) | GA 2026-04-13; snapshots "coming soon" |

### Pricing — the same job, normalized as far as the vendors allow

Worked example given to every agent: one manager sandbox, ~2 vCPU / 4 GiB, **10 jobs a month × 3
minutes of compute**, idle the rest of the month, files kept between jobs; then 50 managers. The
agents' arithmetic is in their reports; the table carries their results. Sizes differ where a
vendor cannot offer 2/4 (noted). **Usage** = metered cost; **floor** = plan fee or minimum.

| Product | Usage / manager / month | Usage, 50 managers | Plan floor | What dominates |
|---|---|---|---|---|
| E2B (2 vCPU/4 GiB custom template) | $0.08 (pause right after) – $0.22 (5-min timeout) | $4.14 – $11.04 | Hobby $0 (+$100 one-time credit, 20 running, US only) / Pro $150 | compute seconds; paused = free |
| Daytona VM (2/4/8 GiB disk) | $0.32 – $0.71 (explicit pause) … $1.98 – $2.37 (default 60-min auto-pause) | $35 – $118 | none ($200 credit) | disk billed while paused ($0.079/GiB/month) |
| Vercel (Pro) | $0.39 – $0.72 | $20 – $36 | Pro $20/seat (includes $20 usage); Hobby non-commercial | memory billed for the whole wall-clock session; snapshots $0.08/GB-month |
| Fly Sprites (8 vCPU fixed, memory auto) | $0.21 now; $0.13 from 2026-10-01 | $10.61 now; $6.48 from Oct 1 | none after Oct 1 | usage-metered CPU/memory; cold storage |
| Fly Machines (shared-cpu-2x, 4 GB) | $0.47 – $0.50 | $26 – $28 | none (support plans optional) | stopped rootfs + volume |
| Modal (1 core = 2 vCPU, 4 GiB) | $0.12 – $0.32 | $6 – $16 | Starter $0 (+$30/month credit, 100 containers) / Team $250 (service users, billing reports) | per-second; Finished = free; check disk quota billed as memory |
| Northflank (2 dedicated vCPU/4 GB) | $0.18 (1 GB volume) – $1.53 (10 GiB) | $9 – $77 | none | volume storage |
| Google Code Execution (2 vCPU/1.5 GiB, cannot pause) | **$127** (running all month) | **$6,601** | none | billed every hour it exists |
| Google Shell/BYOC (paused between jobs) | ~$0 compute (inside free tier) + **paused price not published** | same | none | unknown paused charge |
| AWS Code Interpreter | $0.11 – $0.47 (+ S3 for persistence) | $5 – $23 | none | memory for the held session |
| AWS AgentCore Runtime V2 | $0.18 | $9.30 | none | storage free during preview |
| Azure code interpreter | $0.30 (no persistence) / $21.60 (kept alive) | $15 / $1,080 | none | whole-hour billing per session |
| Cloudflare (standard-3: 2 vCPU/8 GiB — 2/4 not allowed) | inside plan allowance (files lost on sleep) / ~$55.50 with keepAlive | $16 – $24 / ~$2,775 | Workers Paid $5 | provisioned memory while awake |
| No vendor (existing box) | $0 marginal | $0 marginal until RAM runs out | box already paid ($84/mo for 4 vCPU/16 GB) | RAM: measured 390 MB idle per openclaw seat (not a Python sandbox) |

Caveats [I]: these are list prices on one assumed usage pattern; nothing here is measured, and
per [[never-size-from-the-pilot-box]] no pilot traffic sizes it. Several products bill a waiting
approval as running time (Vercel, AWS CI, Cloudflare, Google Code Exec); the E2B/Daytona/Modal/
Sprites figures assume the glue pauses or stops the sandbox right after a job.

### No vendor: sandboxes on trades-box-1

- The box is the Lightsail $84/mo bundle: 4 vCPU, 16 GB RAM, 320 GB SSD, Ubuntu 22.04
  (`Box_Setup_Stuff/migration-runbook-lightsail.md:9-10, 47-50`). Firewall: SSH only.
- Measured today for openclaw seats (memory `lightsail-box-capacity`): ~390 MB idle per seat,
  +415 MB per concurrent turn, "seat COUNT fills a box, not traffic". The Copilot engine that
  replaces openclaw measured 46–62 MB idle for 8 sessions (`docs/engineering-memory.md:1688-1692`).
  No measurement of a Python/openpyxl/reportlab job exists.
- Isolation options that run on Lightsail: plain Docker (runc), rootless Docker, **gVisor**
  (systrap platform needs no virtualization; `runsc checkpoint/restore` saves memory + disk to
  disk) [D gvisor.dev/docs/user_guide/checkpoint_restore], nsjail, bubblewrap.
- **Firecracker, Kata, microsandbox and E2B's self-host runtime all need KVM.** Lightsail's
  `CreateInstances` API has no CPU-options/nested-virtualization parameter; EC2's nested
  virtualization (2026-02-16) covers M/C/R/X/I 7i–8i families only [D
  docs.aws.amazon.com/lightsail/…/API_CreateInstances.html, docs.aws.amazon.com/AWSEC2/…/amazon-ec2-nested-virtualization.html].
  `/dev/kvm` on the box was not checked (no ssh in scope).
- Self-hostable servers: E2B runtime (Apache-2.0; needs KVM; single-host "Embed" is an evaluation
  package), Daytona (open repo frozen at v0.190.0, AGPL; current self-host = runners registered to
  Daytona's hosted control plane), kubernetes-sigs agent-sandbox (needs a cluster).
- Four keys have sudo on the box, and a second operator once killed all six sandboxes mid-session
  (`docs/engineering-memory.md:510-518`).

## Constraints and Invariants

1. **Idle behaviour is the gate.** Every product's default idle behaviour is in the table above;
   three defaults destroy files silently or by default (E2B `kill`, Cloudflare sleep, Azure
   cooldown), and two recreate an EMPTY sandbox under the same id without an error (Azure,
   Cloudflare; Vercel does the same when a snapshot has expired).
2. **Wall-clock vs idle timers.** Vercel's session timeout and AWS Code Interpreter's TTL count
   wall-clock time regardless of activity; E2B, Daytona, Sprites, Modal and Cloudflare count
   inactivity. A job the model starts and then waits on counts differently on each.
3. **"No credential in the sandbox"** — products that inject credentials at the network edge
   instead of inside the sandbox: E2B (egress proxy), Daytona (placeholder replaced by proxy),
   Vercel (firewall `transform`), Fly Sprites ("connectors"), Cloudflare (outbound handlers). AWS
   execution roles and Azure managed identity put credentials INSIDE the sandbox when enabled.
4. **Egress defaults:** open on E2B, Vercel, Sprites, Modal, Cloudflare; restricted on Daytona
   Tier 1/2 (org-wide, not per sandbox); off on Google (Code Exec: no network at all; Shell: off
   unless the template enables it) and Azure (disabled by default).
5. **Per-manager cost attribution** is documented per sandbox on Daytona (Spending page), Vercel
   (metrics by sandbox name), AWS (usage logs per session id), Modal (tags, Team plan); elsewhere
   it would come from our own start/stop records.
6. **The box constraints** the seat glue already carries (`seat-glue@.service`:
   `ProtectSystem=strict`, writable only `/var/lib/seat-glue`) apply to anything run by the glue;
   a box-hosted sandbox runtime would be a separate root-owned service.

## Decision Points

1. **Vendor or no vendor.** The record holds the operator's "I'm fine with hosting sandboxes for
   managers in the box" (quoted) and a later, unquoted "vendor on demand so the box stays
   container-free". On the box: no new bill, no new vendor account or secret, files on local disk,
   but the retirement plan's step 5 "box runs three units" gate changes, isolation is container-
   or gVisor-grade (no microVM on Lightsail), and RAM is shared with every seat. With a vendor:
   microVM isolation on most, one more account and key, per-job cost cents, and the vendor's idle
   rules to design around.
2. **Which idle behaviour the manager seat is built for.**
   - *A — freeze with memory* (E2B with `pause`, Daytona VM, Sprites while warm): a job interrupted
     by sleep resumes where it was; the glue must still handle the resume path and its errors.
   - *B — disk only* (Vercel, Daytona container, Fly, Northflank, AWS Runtime): the job must write
     its state and outputs to disk as it goes (atomic write: temp file, then rename); a job cut off
     mid-run must be re-run.
   - *C/D* (Google Code Exec, AWS CI, Azure, Cloudflare, Modal): the glue copies outputs out after
     every step, or keeps the sandbox alive and pays for idle time.
3. **Where the sandbox's timers are driven from.** Whichever product: something must decide when a
   manager's sandbox sleeps. Vendor idle timers (E2B/Daytona/Sprites/Cloudflare), wall-clock
   timeouts the glue extends (Vercel), or the glue pausing explicitly after each job (Google Shell,
   Fly Machines, Northflank never sleep on their own and bill until paused).
4. **Plan tier.** Several products gate the needed feature or the commercial use behind a plan:
   Vercel Hobby is non-commercial (Pro $20/seat); E2B Hobby is US-only with 20 running sandboxes
   (Pro $150/mo, EU/APAC via support); Runloop suspend needs Pro $250; Modal least-privilege
   service users need Team $250; Daytona network rules per sandbox need Tier 3 ($500 top-up).
5. **Image ownership.** Only Google Code Execution and AWS Code Interpreter ship openpyxl and
   reportlab preinstalled with no build step (and neither allows installs beyond that list in
   Google's case). Everywhere else the skills folder and Python libraries go into a custom
   template/image we build and keep current (E2B template, Daytona snapshot, Vercel VCR image,
   Modal image, Fly/Northflank OCI image) or are installed once and kept on the persistent disk
   (Sprites, Vercel `onCreate`).
6. **How firm data reaches the sandbox.** All products accept files uploaded by the glue; open
   egress would also let sandbox code call the spine directly. With egress closed (Google, Azure
   defaults; E2B/Vercel/Sprites configurable), the glue must carry every input in and every output
   out.

## Open Questions

Answerable only by a hands-on test (each needs a vendor account and key; none was created):
1. E2B: does a paused sandbox resume with the file changes intact after several pause/resume
   cycles (community #884, #1587)? How often does the disk-only fallback happen in practice?
2. Daytona VM: resume latency, and does a toolbox call on a paused VM auto-resume or error?
3. Vercel: actual snapshot size for a Python image with the skills folder (`stop()` returns
   `sizeBytes`) — the only unknown in its cost model.
4. Fly Sprites: when does a warm sprite go cold, and does a silent Python job survive a warm pause
   (processes are documented to continue on warm resume)? Region cannot be chosen — where does it run?
5. Google: does pause/resume apply to Code Execution sandboxes, and what does a paused Shell
   sandbox cost? Neither is documented.
6. The box: is `/dev/kvm` present on trades-box-1 (`ls -l /dev/kvm`)? What does one Python export
   job use in RAM? (Neither measured.)
7. Cloudflare: does an in-flight exec request reset `sleepAfter`?
8. Azure Container Apps Sandboxes (`SandboxGroups`) — suspend, snapshots and volumes are documented
   but the product was not researched in depth (status reads as preview; Python SDK only).
9. Whether each vendor's compliance scope (SOC 2 / HIPAA BAA) covers the sandbox product itself —
   unverified for Vercel, Fly Sprites, Google pre-GA, Azure sessions; Cloudflare Containers are
   outside its SOC 2 list.
10. Fly's 2026-10-01 pricing change: which Sprites limits (concurrency, creation rate) apply once
    plans are removed.
