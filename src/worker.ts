import { definePlugin, runWorker, type PluginContext, type PluginConfigChangeContext, type PluginLogger, type PluginConfigValidationResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import { MatrixClient, mentionsUser, messageBody, stripMention, type MatrixEvent } from "./matrix-client.js";

/**
 * Matrix Chat Bridge worker — multi-endpoint, proactive-plugin pattern.
 *
 * Config shape (company-scoped configJson):
 * {
 *   homeserverUrl: string,          // global
 *   wakeOn: "mention" | "all",      // global default
 *   commandPrefix: string,          // global
 *   endpoints: [                    // per-agent bindings (like the Slack connector)
 *     { agentId, accessToken, listenRooms: string[], wakeOn? }
 *   ]
 * }
 *
 * One Matrix account + one sync loop + one session map per endpoint. The sync
 * loop is started via setTimeout(0) OUTSIDE the configChanged invocation's
 * AsyncLocalStorage context, so its worker→host calls are genuinely proactive
 * (no paperclipInvocationId) and resolve against the plugin's configured
 * companies via params.companyId.
 */

interface EndpointConfig {
  agentId: string;
  accessToken: string;
  listenRooms: string[];
  wakeOn?: "mention" | "all";
}

interface BridgeConfig {
  companyId: string;
  homeserverUrl: string;
  commandPrefix: string;
  wakeOn: "mention" | "all";
  endpoints: EndpointConfig[];
}

const STATE_KEY = "bridge";
const STATE_NAMESPACE = "matrix";

let pluginCtx: PluginContext | null = null;
let activeBridges: { stop: () => void; name: string }[] = [];
let activeConfig: BridgeConfig | null = null;
let pendingConfig: BridgeConfig | null = null;

function parseConfig(raw: unknown): Omit<BridgeConfig, "companyId"> | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  const homeserverUrl = typeof cfg.homeserverUrl === "string" ? cfg.homeserverUrl : "";
  if (!homeserverUrl) return null;
  const eps: EndpointConfig[] = [];
  if (Array.isArray(cfg.endpoints)) {
    for (const e of cfg.endpoints) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      const agentId = typeof o.agentId === "string" ? o.agentId : "";
      const accessToken = typeof o.accessToken === "string" ? o.accessToken : "";
      if (!agentId || !accessToken) continue;
      eps.push({
        agentId,
        accessToken,
        listenRooms: Array.isArray(o.listenRooms) ? (o.listenRooms as string[]) : [],
        wakeOn: o.wakeOn === "all" ? "all" : o.wakeOn === "mention" ? "mention" : undefined,
      });
    }
  }
  if (!eps.length) return null;
  return {
    homeserverUrl,
    endpoints: eps,
    wakeOn: cfg.wakeOn === "all" ? "all" : "mention",
    commandPrefix: "!", // locked; any stored value is overridden
  };
}

async function startEndpointBridge(ctx: PluginContext, config: BridgeConfig, ep: EndpointConfig, agentName: string): Promise<{ stop: () => void; name: string }> {
  const logger = ctx.logger;
  const wakeOn = ep.wakeOn ?? config.wakeOn;
  const matrix = new MatrixClient(config.homeserverUrl, ep.accessToken, (u, i) => ctx.http.fetch(u.toString(), i));
  const whoami = await matrix.whoami();
  logger.info("Endpoint up", { agent: agentName, matrixUser: whoami.user_id });

  const joined = new Set<string>();
  for (const room of ep.listenRooms) {
    try {
      const r = await matrix.joinRoom(room);
      joined.add(r.room_id);
    } catch (err) {
      logger.error("join failed", { agent: agentName, room, error: String(err) });
    }
  }
  if (!ep.listenRooms.length) {
    const r = await matrix.joinedRooms();
    r.joined_rooms.forEach((id: string) => joined.add(id));
  }

  // per-endpoint session persistence, namespaced by matrix user
  const stateKey = `${STATE_KEY}:${whoami.user_id}`;
  const sessions = new Map<string, { sessionId: string | null }>();
  const stored = await ctx.state
    .get({ scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey })
    .catch(() => null);
  let storedSince: string | undefined;
  if (stored && typeof stored === "object") {
    // v0.3.2+ shape: { rooms: { roomId: { sessionId } }, since: token }
    // legacy shape: { roomId: { sessionId } } flat map (no since)
    const s = stored as Record<string, unknown>;
    if (s.rooms && typeof s.rooms === "object") {
      for (const [roomId, val] of Object.entries(s.rooms as Record<string, { sessionId?: string | null }>)) {
        sessions.set(roomId, { sessionId: val.sessionId ?? null });
      }
      if (typeof s.since === "string") storedSince = s.since;
    } else {
      for (const [roomId, val] of Object.entries(s as Record<string, { sessionId?: string | null }>)) {
        if (roomId === "since") continue;
        sessions.set(roomId, { sessionId: val?.sessionId ?? null });
      }
    }
  }

  let stopped = false;
  let since: string | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persistSessions = async () => {
    const dump: Record<string, { sessionId: string | null }> = {};
    for (const [roomId, st] of sessions) dump[roomId] = { sessionId: st.sessionId };
    await ctx.state
      .set({ scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey }, { rooms: dump, since })
      .catch(() => undefined);
  };

  // Persist the sync cursor alongside sessions so a restart resumes exactly
  // where it left off instead of replaying the backlog as a wave of replies.
  since = storedSince;

  const ensureSession = async (roomId: string): Promise<string> => {
    const st = sessions.get(roomId);
    if (st?.sessionId) {
      try {
        const live = await ctx.agents.sessions.list(ep.agentId, config.companyId);
        if (live.some((s) => s.sessionId === st.sessionId && s.status === "active")) return st.sessionId;
      } catch {
        /* fall through */
      }
    }
    // taskKey MUST match `plugin:<pluginKey>:session:%` — the host's send/list
    // gate only admits sessions whose taskKey carries the plugin's own prefix.
    const taskKey = `plugin:paperclip.matrix-chat:session:${whoami.user_id}:${roomId}`;
    try {
      const session = await ctx.agents.sessions.create(ep.agentId, config.companyId, {
        taskKey,
        reason: `Matrix bridge (${whoami.user_id}) for room ${roomId}`,
      });
      sessions.set(roomId, { sessionId: session.sessionId });
      void persistSessions();
      return session.sessionId;
    } catch (err) {
      // create can hit the unique index (company,agent,adapter,task_key) when a
      // session for this room already exists but our state cache was wiped
      // (e.g. plugin purge/reinstall). Recover by adopting the existing row.
      const list = await ctx.agents.sessions.list(ep.agentId, config.companyId);
      // AgentSession doesn't expose taskKey — adopt the newest active session
      // created for a matrix bridge of this endpoint. Risk of mis-adoption is
      // nil in practice: each endpoint maps to one agent and one taskKey.
      const mine = list.filter((s) => s.status === "active" && s.agentId === ep.agentId);
      const existing = mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (!existing) throw err;
      logger.info("adopted pre-existing session after create conflict", { agent: agentName, roomId });
      sessions.set(roomId, { sessionId: existing.sessionId });
      void persistSessions();
      return existing.sessionId;
    }
  };

  const reply = async (roomId: string, text: string) => {
    await matrix.sendMessage(roomId, text.slice(0, 3500));
  };

  const handleCommand = async (roomId: string, body: string, ev: MatrixEvent): Promise<boolean> => {
    const prefix = config.commandPrefix || "!";
    // Command may be bare ("!status") or targeted at a bot via mention, in
    // either order: "!status @zed-bot" or "@zed-bot !status".
    const me = whoami.user_id;
    const mentionAnywhere = new RegExp(`@${me.split("@")[1].split(":")[0]}(?::|\\b)`);
    const mentionsMe = mentionAnywhere.test(body);
    const stripped = body.replace(mentionAnywhere, "").trim();
    const startsWithPrefix = stripped.startsWith(prefix);
    // A prefix-less body that mentions us and is not a command falls through to
    // the normal wake path (mention -> agent).
    if (!startsWithPrefix) return false;
    const cmd = stripped.slice(prefix.length).trim().replace(/[!.,]+$/, "");

    // When the sender mentions a bot other than us, this command isn't ours.
    const otherBotMention = body.match(/@([a-z0-9._=/+-]+)-bot(?::|\b)/i);
    if (otherBotMention && !mentionsMe) return false; // targeted at a sibling bridge

    if (cmd === "status") {
      await reply(roomId, `bridge v${manifest.version} [${me}]: agent ${agentName}, wake=${wakeOn}, rooms=${joined.size}`);
      return true;
    }
    if (cmd === "new-session" || cmd === "new") {
      const st = sessions.get(roomId);
      if (st?.sessionId) await ctx.agents.sessions.close(st.sessionId, config.companyId).catch(() => undefined);
      sessions.set(roomId, { sessionId: null });
      void persistSessions();
      await reply(roomId, "session reset — next message starts a fresh conversation");
      return true;
    }
    await reply(roomId, `unknown command. try: ${prefix} status | ${prefix} new  (optionally @<bot>)`);
    return true;
  };

  const onRoomEvent = async (roomId: string, ev: MatrixEvent) => {
    if (!joined.has(roomId) && ep.listenRooms.length > 0) return;
    if (ev.sender === whoami.user_id) return;

    if (ev.type === "m.room.member" && (ev.content as { membership?: string }).membership === "invite") {
      if (ev.state_key === whoami.user_id) {
        try {
          await matrix.joinRoom(roomId);
          joined.add(roomId);
          logger.info("auto-joined on invite", { agent: agentName, roomId });
        } catch (err) {
          logger.warn("invite join failed", { agent: agentName, roomId, error: String(err) });
        }
      }
      return;
    }

    const body = messageBody(ev);
    if (body === null) return;
    if (await handleCommand(roomId, body, ev)) return;

    const mentioned = mentionsUser(ev, whoami.user_id, body);
    if (wakeOn === "mention" && !mentioned) return;

    const prompt = stripMention(body, whoami.user_id) || "(mentioned with empty message)";
    const senderLocal = ev.sender.split(":")[0].replace("@", "");

    let sessionId: string;
    try {
      sessionId = await ensureSession(roomId);
    } catch (err) {
      logger.error("session create failed", { agent: agentName, roomId, error: String(err) });
      await reply(roomId, "⚠️ could not open an agent session");
      return;
    }

    // sendMessage returns { runId } immediately; done/error events stream in
    // asynchronously. Await them before replying — the agent run can
    // legitimately take many minutes (agent timeoutSec ceiling is 7200s).
    // Soft deadline: after SOFT_TIMEOUT_MS post a "still working" notice but
    // KEEP LISTENING until HARD_TIMEOUT_MS so a late success still lands.
    const SOFT_TIMEOUT_MS = 15 * 60_000;
    const HARD_TIMEOUT_MS = 110 * 60_000; // < 7200s agent ceiling, safe margin
    let settled = false;
    let settleRun: (v: { text: string | null; error: string | null; late?: boolean }) => void = () => {};
    const runDone = new Promise<{ text: string | null; error: string | null; late?: boolean }>((resolve) => {
      settleRun = (v) => { if (!settled) { settled = true; resolve(v); } };
      setTimeout(() => { if (!settled) resolve({ text: null, error: "run timed out waiting for reply", late: true }); }, SOFT_TIMEOUT_MS);
      setTimeout(() => settleRun({ text: null, error: `no reply within ${Math.round(HARD_TIMEOUT_MS / 60_000)} minutes` }), HARD_TIMEOUT_MS);
    });
    try {
      await ctx.agents.sessions.sendMessage(sessionId, config.companyId, {
        prompt: `[matrix bridge | ${whoami.user_id} | room ${roomId} | from ${ev.sender} (${senderLocal})]\n${prompt}`,
        reason: `matrix message ${ev.event_id}`,
        onEvent: (evt) => {
          if (evt.eventType === "done") settleRun({ text: evt.message ?? null, error: null });
          if (evt.eventType === "error") settleRun({ text: null, error: evt.message ?? "agent run failed" });
        },
      });
    } catch (err) {
      logger.error("sendMessage failed", { agent: agentName, roomId, error: String(err) });
      await reply(roomId, "⚠️ agent run failed to start");
      return;
    }
    const outcome = await runDone;
    if (outcome.late && !outcome.text) {
      // soft deadline hit: tell the room we're still on it, then keep waiting
      await reply(roomId, `⏳ still working — run is taking longer than ${Math.round(SOFT_TIMEOUT_MS / 60_000)} min; I'll follow up when it finishes`);
      const final = await new Promise<{ text: string | null; error: string | null }>((resolve) => {
        settleRun = (v) => resolve(v);
        setTimeout(() => resolve({ text: null, error: null }), HARD_TIMEOUT_MS - SOFT_TIMEOUT_MS);
      });
      if (final.text) await reply(roomId, final.text);
      else if (final.error) await reply(roomId, `⚠️ ${final.error}`.slice(0, 500));
      // neither: hard timeout already announced its own window above
      return;
    }
    if (outcome.text) await reply(roomId, outcome.text);
    else await reply(roomId, outcome.error ? `⚠️ ${outcome.error}`.slice(0, 500) : "(no reply)");
  };

  const loop = async () => {
    let firstCycle = !since; // no stored sync token -> catch-up mode
    while (!stopped) {
      try {
        // 20s long-poll: the host's http.fetch RPC has a 30s ceiling; a 60s
        // sync timeout would RPC-timeout every cycle.
        const res = await matrix.sync(since, 20_000);
        since = res.next_batch;
        if (firstCycle) {
          // First sync after startup with no token: discard the backlog so a
          // plugin restart/update doesn't replay old messages into a wave of
          // bot replies. Only messages arriving AFTER startup are bridged.
          firstCycle = false;
          logger.info("startup sync: backlog discarded", { agent: agentName });
          continue;
        }
        for (const [roomId, data] of Object.entries(res.rooms?.join ?? {})) {
          for (const ev of data.timeline?.events ?? []) {
            try {
              await onRoomEvent(roomId, ev);
            } catch (err) {
              logger.warn("event handler error", { agent: agentName, roomId, error: String(err) });
            }
          }
        }
      } catch (err) {
        logger.warn("sync error; backing off", { agent: agentName, error: String(err) });
        await new Promise<void>((r) => {
          timer = setTimeout(r, 5_000);
        });
      }
    }
    logger.info("sync loop stopped", { agent: agentName });
  };
  void loop();

  logger.info("Matrix endpoint bridge started", {
    agent: agentName,
    matrixUser: whoami.user_id,
    rooms: [...joined],
    wakeOn,
  });

  return {
    name: `${agentName} (${whoami.user_id})`,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function startAllBridges(ctx: PluginContext, config: BridgeConfig) {
  const logger = ctx.logger;
  for (const b of activeBridges) b.stop();
  activeBridges = [];
  activeConfig = config;

  const agents = await ctx.agents.list({ companyId: config.companyId });
  for (const ep of config.endpoints) {
    const agent = agents.find((a) => a.id === ep.agentId);
    if (!agent) {
      logger.error("endpoint agent not found; skipping", { agentId: ep.agentId });
      continue;
    }
    try {
      const b = await startEndpointBridge(ctx, config, ep, agent.name);
      activeBridges.push(b);
    } catch (err) {
      logger.error("endpoint bridge failed to start", { agentId: ep.agentId, error: String(err) });
    }
  }
  logger.info("Matrix bridge online", { endpoints: activeBridges.length, companyId: config.companyId });
}

export const matrixChatPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginCtx = ctx;
    ctx.logger.info(`${manifest.displayName} v${manifest.version} setup (awaiting config replay)`, {
      pluginId: manifest.id,
    });
  },

  async onValidateConfig(config: Record<string, unknown>): Promise<PluginConfigValidationResult> {
    const errors: string[] = [];
    if (config.commandPrefix !== undefined && config.commandPrefix !== "!") {
      errors.push('commandPrefix is locked to "!" and cannot be changed.');
    }
    return { ok: errors.length === 0, errors };
  },

  async onConfigChanged(newConfig: Record<string, unknown>, context?: PluginConfigChangeContext) {
    const logger: PluginLogger = pluginCtx?.logger ?? (console as unknown as PluginLogger);
    if (!pluginCtx) return;
    if (!context?.companyId) {
      logger.info("instance-wide config save; nothing to rebind");
      return;
    }
    const parsed = parseConfig(newConfig);
    if (!parsed) {
      logger.info("config incomplete; bridge idle", { companyId: context.companyId });
      return;
    }
    const config: BridgeConfig = { ...parsed, companyId: context.companyId };
    // Do NOT make host calls or start loops from here: this handler runs inside
    // the host's configChanged AsyncLocalStorage frame, and any call scheduled
    // from it (even via setTimeout) echoes the invocation id, which expires the
    // moment the replay completes. Just stash the config; the module-scope
    // apply-loop (created at import time, outside every host request) picks it
    // up on its next tick and its worker->host calls are genuinely proactive.
    pendingConfig = config;
    logger.info("config stashed; apply-loop will bind", { companyId: context.companyId, endpoints: config.endpoints.length });
  },

  async onHealth() {
    return {
      status: activeBridges.length ? "ok" : "degraded",
      message: activeBridges.length
        ? `Matrix bridge v${manifest.version}: ${activeBridges.length} endpoint(s): ${activeBridges.map((b) => b.name).join(", ")}`
        : `Matrix bridge v${manifest.version} idle (no config)`,
    };
  },
});

export default matrixChatPlugin;

// Module-scope apply loop: created at import time — before any host request —
// so its callback chain carries no AsyncLocalStorage store and its worker->host
// calls are truly proactive (params.companyId + configured-company scopes).
// This is the host's designed path for "timer/loop" plugins.
let appliedFingerprint = "";
const APPLY_INTERVAL_MS = 3_000;
setInterval(() => {
  const config = pendingConfig;
  const ctx = pluginCtx;
  if (!config || !ctx) return;
  const fingerprint = JSON.stringify(config);
  if (fingerprint === appliedFingerprint && (activeBridges.length || config.endpoints.length === 0)) return;
  if (fingerprint === appliedFingerprint) return;
  appliedFingerprint = fingerprint;
  void startAllBridges(ctx, config).catch((err) => {
    ctx.logger.error("bridge start failed", { error: String(err) });
    appliedFingerprint = ""; // allow retry on next tick
  });
}, APPLY_INTERVAL_MS);

runWorker(matrixChatPlugin, import.meta.url);
