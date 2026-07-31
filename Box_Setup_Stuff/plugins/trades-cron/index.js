/**
 * trades-cron — flat-schema replacement for OpenClaw's built-in `cron` tool.
 *
 * WHY THIS EXISTS
 * Every inference request compiles each tool's `parameters` JSON-Schema into a
 * constrained-decoding grammar before the first token is emitted. Cost scales with
 * schema *shape* (nesting/branching), not with token count or tool count. The
 * built-in `cron` tool nests four levels deep and carries the whole job tree TWICE
 * (`job` for add, `patch` for update), each with `schedule`/`payload`/`delivery`
 * (→`failureDestination`)/`failureAlert`. Measured on s2: ~2.7s of grammar compile
 * on EVERY turn, whether or not cron is used. See docs/engineering-memory.md §4.
 *
 * This tool exposes the same capability as a single flat object of scalars, so the
 * grammar is trivial, and rebuilds the nested shape server-side in `execute`.
 * Schema guidance that would have cost grammar time lives in the description
 * instead — descriptions are not compiled into the grammar.
 *
 * It also fixes a real bug: the built-in exposes `gatewayUrl`/`gatewayToken`, which
 * GLM-5.2 hallucinated on most calls and got rejected for ("gatewayUrl override
 * rejected", "pairing required"), burning turns. Those params are gone here and
 * `additionalProperties: false` means the grammar cannot emit them at all.
 *
 * Session/delivery binding (agentId, sessionKey, announce target inferred from the
 * live chat) is reproduced from the built-in's execute path using the plugin tool
 * factory context, so "remind me in an hour" still comes back to the right chat.
 */

export const ACTIONS = ["status", "list", "get", "add", "update", "remove", "run", "runs", "wake"];

/**
 * `callGatewayTool` is the same function the built-in cron tool uses. Resolve it
 * lazily and from several candidates: plugins live outside the OpenClaw package's
 * module graph, so a bare specifier only resolves when a `node_modules/openclaw`
 * link exists next to this file. Falling back to the running CLI's own directory
 * keeps the plugin working without one, and keeps a failed resolve from taking
 * down plugin load (the tool errors on call instead of the bot losing all tools).
 */
let cachedCall;
async function gatewayCall(method, params, extra) {
  if (!cachedCall) {
    const candidates = ["openclaw/plugin-sdk/agent-harness-runtime"];
    // Derive from the running openclaw entrypoint (…/openclaw/openclaw.mjs).
    const argv1 = typeof process !== "undefined" ? process.argv?.[1] : undefined;
    if (typeof argv1 === "string" && argv1.includes("openclaw")) {
      const root = argv1.slice(0, argv1.lastIndexOf("/"));
      candidates.push(`${root}/dist/plugin-sdk/agent-harness-runtime.js`);
    }
    candidates.push("/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-runtime.js");
    const failures = [];
    for (const candidate of candidates) {
      try {
        const mod = await import(candidate);
        if (typeof mod?.callGatewayTool === "function") {
          cachedCall = mod.callGatewayTool;
          break;
        }
        failures.push(`${candidate}: no callGatewayTool export`);
      } catch (err) {
        failures.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!cachedCall) {
      throw new Error(`cron_job: could not load the OpenClaw gateway bridge.\n${failures.join("\n")}`);
    }
  }
  // Same 60s budget the built-in cron tool uses.
  return await cachedCall(method, { timeoutMs: 60000 }, params, extra);
}

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function str(params, key) {
  const value = params?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function num(params, key) {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(params, key) {
  const value = params?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireJobId(params) {
  const id = str(params, "jobId");
  if (!id) throw new Error("jobId required");
  return id;
}

/** Build the nested `schedule` the Gateway expects from flat fields. */
export function buildSchedule(params) {
  const at = str(params, "at");
  const everyMs = num(params, "everyMs");
  const expr = str(params, "expr");
  const tz = str(params, "tz");
  if (at) return { kind: "at", at };
  if (everyMs !== undefined) return { kind: "every", everyMs };
  if (expr) return { kind: "cron", expr, ...(tz ? { tz } : {}) };
  return undefined;
}

/** Build the nested `payload` the Gateway expects from flat fields. */
export function buildPayload(params) {
  const message = str(params, "message");
  const text = str(params, "text");
  if (message) {
    const timeoutSeconds = num(params, "timeoutSeconds");
    return {
      kind: "agentTurn",
      message,
      ...(str(params, "model") ? { model: str(params, "model") } : {}),
      ...(str(params, "thinking") ? { thinking: str(params, "thinking") } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    };
  }
  if (text) return { kind: "systemEvent", text };
  return undefined;
}

/**
 * Delivery for agentTurn jobs. When the model does not name a target we inherit
 * the live chat route, mirroring the built-in's resolveCronCreationDelivery — this
 * is what makes a scheduled reminder come back to the chat that asked for it.
 */
export function buildDelivery(params, deliveryContext) {
  const mode = str(params, "deliveryMode");
  const channel = str(params, "deliveryChannel");
  const to = str(params, "deliveryTo");
  if (mode === "webhook") {
    if (!to) throw new Error('deliveryMode="webhook" requires deliveryTo to be an http(s) URL');
    return { mode: "webhook", to };
  }
  if (mode === "none") return { mode: "none" };
  if (channel || to) return { mode: "announce", ...(channel ? { channel } : {}), ...(to ? { to } : {}) };
  if (deliveryContext && (deliveryContext.channel || deliveryContext.to)) {
    return {
      mode: "announce",
      ...(deliveryContext.channel ? { channel: deliveryContext.channel } : {}),
      ...(deliveryContext.to ? { to: deliveryContext.to } : {}),
      ...(deliveryContext.accountId ? { accountId: deliveryContext.accountId } : {}),
      ...(deliveryContext.threadId !== undefined && deliveryContext.threadId !== null
        ? { threadId: deliveryContext.threadId }
        : {}),
    };
  }
  return mode ? { mode } : undefined;
}

/**
 * The Gateway rejects mismatched pairs, but its error surfaces late and reads as a
 * generic validation failure. Check here so the model gets an actionable message.
 */
function assertTargetPayloadMatch(sessionTarget, payloadKind) {
  if (sessionTarget === "main" && payloadKind !== "systemEvent") {
    throw new Error('sessionTarget="main" requires a systemEvent job: pass `text`, not `message`.');
  }
  if (sessionTarget !== "main" && payloadKind !== "agentTurn") {
    throw new Error(`sessionTarget="${sessionTarget}" requires an agentTurn job: pass \`message\`, not \`text\`.`);
  }
}

export function buildJob(params, ctx) {
  const schedule = buildSchedule(params);
  if (!schedule) {
    throw new Error("a schedule is required: pass `at` (one-shot), `everyMs` (interval), or `expr` (+ optional `tz`).");
  }
  const payload = buildPayload(params);
  if (!payload) throw new Error("a payload is required: pass `message` (agentTurn) or `text` (systemEvent).");

  const sessionTarget = str(params, "sessionTarget") ?? (payload.kind === "agentTurn" ? "isolated" : "main");
  assertTargetPayloadMatch(sessionTarget, payload.kind);

  const job = {
    ...(str(params, "name") ? { name: str(params, "name") } : {}),
    schedule,
    payload,
    sessionTarget,
    ...(bool(params, "enabled") !== undefined ? { enabled: bool(params, "enabled") } : {}),
    ...(bool(params, "deleteAfterRun") !== undefined ? { deleteAfterRun: bool(params, "deleteAfterRun") } : {}),
    ...(str(params, "wakeMode") ? { wakeMode: str(params, "wakeMode") } : {}),
  };

  if (payload.kind === "agentTurn") {
    const delivery = buildDelivery(params, ctx?.deliveryContext);
    if (delivery) job.delivery = delivery;
  }
  // Bind the job to this agent/session the way the built-in tool does, so `list`
  // stays scoped and non-isolated jobs resume in the right conversation.
  if (ctx?.agentId) job.agentId = ctx.agentId;
  if (ctx?.sessionKey && sessionTarget !== "isolated") job.sessionKey = ctx.sessionKey;
  return job;
}

/** Only the fields the model actually named, so update stays a patch. */
export function buildPatch(params, ctx) {
  const patch = {};
  const schedule = buildSchedule(params);
  if (schedule) patch.schedule = schedule;
  const payload = buildPayload(params);
  if (payload) patch.payload = payload;
  const sessionTarget = str(params, "sessionTarget");
  if (sessionTarget) patch.sessionTarget = sessionTarget;
  if (str(params, "name")) patch.name = str(params, "name");
  if (bool(params, "enabled") !== undefined) patch.enabled = bool(params, "enabled");
  if (bool(params, "deleteAfterRun") !== undefined) patch.deleteAfterRun = bool(params, "deleteAfterRun");
  if (str(params, "wakeMode")) patch.wakeMode = str(params, "wakeMode");
  const delivery = buildDelivery(params, undefined);
  if (delivery) patch.delivery = delivery;
  if (Object.keys(patch).length === 0) {
    throw new Error("nothing to update: pass at least one field to change (e.g. `message`, `at`, `expr`, `enabled`).");
  }
  return patch;
}

const DESCRIPTION = `Schedule Gateway background work: reminders, check-back-later, delayed follow-ups, recurring jobs, and wake events. Do NOT emulate scheduling with exec sleep or process polling.

This schedules AGENT/SYSTEM work by wall-clock time. It is NOT for booking customer visits — use the spine scheduling tools for those.

ACTIONS
- status: scheduler status. No other fields.
- list: this agent's jobs. Optional includeDisabled.
- get / remove / run / runs: need jobId. run triggers immediately (runMode "force" default).
- add: create a job. Needs one schedule field + one payload field.
- update: change a job. Needs jobId + the fields to change.
- wake: send a wake event now. Needs text, optional wakeMode.

SCHEDULE (add/update — pick exactly one)
- at: ISO-8601 one-shot, e.g. "2026-08-04T16:30:00Z". No timezone suffix means UTC.
- everyMs: fixed interval in milliseconds.
- expr: 5/6-field cron expression, optionally with tz.
  Write expr in LOCAL wall-clock time and set tz; do NOT convert to UTC first.
  Omitting tz means the Gateway host's local timezone, not UTC.
  Example, 6pm Shanghai daily: expr "0 18 * * *", tz "Asia/Shanghai".
  Note: when both day-of-month and day-of-week are set, cron fires if EITHER matches.

PAYLOAD (add — pick exactly one)
- message: prompt for a full agent turn. Use this for anything that does work.
- text: text injected as a system event into the main session. Use for plain reminders.

SESSION TARGET (optional; defaults are almost always right)
- message -> defaults to "isolated" (fresh session, runs as a background task)
- text -> defaults to "main" (main session system event)
- "current" binds this conversation; "session:<id>" uses a persistent named session.
- HARD RULE: "main" requires text; "isolated"/"current"/"session:<id>" require message.

DELIVERY (optional, agentTurn only)
Omit it and the result is announced back to the current chat automatically — that is
the normal case for "remind me...". Set deliveryChannel/deliveryTo to send elsewhere,
deliveryMode "none" to stay silent, or deliveryMode "webhook" + deliveryTo <url> to POST.

OTHER
- deleteAfterRun: delete once it has run (default true for one-shot "at" jobs).
- timeoutSeconds/model/thinking: agentTurn overrides. 0 timeout means no timeout.`;

export const PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ACTIONS, description: "What to do." },
    jobId: { type: "string", description: "Job id, for get/update/remove/run/runs." },
    name: { type: "string", description: "Human-readable job name." },
    at: { type: "string", description: "One-shot ISO-8601 time." },
    everyMs: { type: "number", description: "Repeat interval in milliseconds." },
    expr: { type: "string", description: "Cron expression, in tz wall-clock time." },
    tz: { type: "string", description: 'IANA timezone for expr, e.g. "America/Los_Angeles".' },
    message: { type: "string", description: "Prompt to run as a full agent turn." },
    text: { type: "string", description: "System-event text (also the wake text)." },
    sessionTarget: { type: "string", description: "main | isolated | current | session:<id>" },
    deliveryMode: { type: "string", enum: ["none", "announce", "webhook"], description: "Where the result goes." },
    deliveryChannel: { type: "string", description: "Delivery channel, e.g. telegram." },
    deliveryTo: { type: "string", description: "Delivery target id, or the URL when webhook." },
    timeoutSeconds: { type: "number", description: "Agent-turn timeout; 0 means none." },
    deleteAfterRun: { type: "boolean", description: "Delete the job after it runs once." },
    enabled: { type: "boolean", description: "Enable or disable the job." },
    model: { type: "string", description: "Model override for the run." },
    thinking: { type: "string", description: "Thinking-level override for the run." },
    includeDisabled: { type: "boolean", description: "list: include disabled jobs." },
    runMode: { type: "string", enum: ["due", "force"], description: 'run: "force" (default) ignores due time.' },
    wakeMode: { type: "string", enum: ["now", "next-heartbeat"], description: "When the wake fires." },
  },
  required: ["action"],
  additionalProperties: false,
};

export function createCronJobTool(ctx) {
  return {
    name: "cron_job",
    label: "Cron",
    displaySummary: "Schedule reminders, cron, wake events.",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    execute: async (_toolCallId, args) => {
      const params = args && typeof args === "object" ? args : {};
      const action = str(params, "action");
      if (!action) throw new Error("action required");
      if (!ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}`);

      switch (action) {
        case "status":
          return jsonResult(await gatewayCall("cron.status", {}));
        case "list":
          return jsonResult(
            await gatewayCall("cron.list", {
              includeDisabled: Boolean(bool(params, "includeDisabled")),
              ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
            }),
          );
        case "get":
          return jsonResult(await gatewayCall("cron.get", { id: requireJobId(params) }));
        case "add":
          return jsonResult(await gatewayCall("cron.add", buildJob(params, ctx)));
        case "update": {
          const id = requireJobId(params);
          return jsonResult(await gatewayCall("cron.update", { id, patch: buildPatch(params, ctx) }));
        }
        case "remove":
          return jsonResult(await gatewayCall("cron.remove", { id: requireJobId(params) }));
        case "run": {
          const id = requireJobId(params);
          const runMode = str(params, "runMode");
          return jsonResult(
            await gatewayCall("cron.run", { id, mode: runMode === "due" ? "due" : "force" }),
          );
        }
        case "runs":
          return jsonResult(await gatewayCall("cron.runs", { id: requireJobId(params) }));
        case "wake": {
          const text = str(params, "text");
          if (!text) throw new Error("text required for wake");
          const mode = str(params, "wakeMode");
          return jsonResult(
            await gatewayCall(
              "wake",
              { mode: mode === "now" ? "now" : "next-heartbeat", text },
              { expectFinal: false },
            ),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}

export default function register(api) {
  // Factory form: the runtime hands us the live session/agent/delivery context per
  // turn, which is what lets `add` bind jobs the way the built-in cron tool does.
  api.registerTool((ctx) => createCronJobTool(ctx ?? {}));
}
