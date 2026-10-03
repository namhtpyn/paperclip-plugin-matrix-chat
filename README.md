# Paperclip Matrix Chat Bridge Plugin

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that bridges Matrix rooms and DMs to Paperclip agents — one endpoint per agent, Slack-connector style. Each endpoint binds a Matrix bot account to a Paperclip agent and a room allowlist. Inbound messages become agent-session prompts; the agent's final reply is posted back to the room.

Runs a zero-dependency Matrix client (raw Client-Server API `/sync` long-poll) inside the plugin worker — no `matrix-js-sdk`, no native crypto, no npm installs at plugin-install time.

## Features

- **Multi-endpoint**: N agents, each with its own Matrix bot account, room allowlist, and wake policy
- **Wake modes**: `all` (reply to every message) or `mention` (reply only when mentioned — pill or typed `@bot:`)
- **Per-room sessions**: conversation memory per room per endpoint; resettable on demand
- **Room commands** (prefix locked to `!`):
  - `!status` — every bridge in the room reports its bot/agent/config
  - `!status @bot` or `@bot !status` — only that bot answers
  - `!new` / `!new-session` — reset that room's conversation (same targeting rules)
- **Auto-join on invite** — invite the bot to any room and it joins and bridges
- **Session persistence** across worker restarts via plugin state

## Requirements


- Paperclip with plugin support (plugin SDK 1.0.0), reachable Matrix homeserver
- One Matrix account per agent (create via your homeserver's admin API; e.g. Synapse shared-secret registration)

## Build

```bash
npm install          # installs the vendored SDK shim (see note)
npm run build        # tsc -> dist/
npm run smoke        # optional: unit + live-homeserver smoke tests
```

> **Vendored SDK**: `sdk-shim/` contains the official `@paperclipai/plugin-sdk` 1.0.0 dist (MIT, [source](https://github.com/paperclipai/paperclip/tree/main/packages/plugins/sdk)) so the plugin builds without registry access. The host provides the real SDK at runtime; the shim exists for type-checking and local builds only.

## Install

In Paperclip (Settings → Plugins → Install from local path), or via API:

```bash
curl -X POST https://<your-paperclip>/api/plugins/install \
  -H "Authorization: Bearer <board-key>" -H "Content-Type: application/json" \
  -d '{"packageName": "/path/to/paperclip-plugin-matrix-chat", "isLocalPath": true}'
```

> Use a **persistent path on the Paperclip volume** (e.g. `/paperclip/plugins-src/...`) — local-path installs run in place, and a path under `/tmp` dies with the container.

## Configure

Company-scoped config (Settings → Plugins → Matrix Chat Bridge):

```jsonc
{
  "homeserverUrl": "https://matrix.example.com",
  "wakeOn": "mention",            // default policy; endpoints may override
  "commandPrefix": "!",           // locked — non-"!" values are rejected
  "endpoints": [
    {
      "agentId": "<paperclip agent uuid>",
      "accessToken": "<matrix bot access token>",
      "listenRooms": ["!roomid:matrix.example.com"],  // [] = all joined rooms
      "wakeOn": "mention"          // optional per-endpoint override
    }
  ]
}
```

The worker validates each token (`whoami`), joins allowlisted rooms, and starts one `/sync` loop per endpoint.

## Gotchas learned the hard way (Paperclip plugin SDK)

- **Proactive host calls**: don't make `ctx.*` calls from `onConfigChanged` (even via `setTimeout`) — AsyncLocalStorage propagates through timers, so calls echo the expired config-replay invocation ID and fail with `invalidInvocationScope`. Start loops at **module scope** (created before any host request) so their calls carry no invocation and resolve via `params.companyId` against configured-company scopes.
- **`http.fetch` RPC ceiling is 30s** — keep `/sync` long-poll ≤ 20s.
- **`agents.sessions.*` taskKey must match `plugin:<pluginKey>:session:*`** or send/list fail with "Session not found" (undocumented in SDK types).
- **`sendMessage` is async** — it returns `{runId}` immediately; await the `done`/`error` session events before replying.

## License

MIT
