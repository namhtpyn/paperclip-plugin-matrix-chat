import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.matrix-chat";
export const PLUGIN_VERSION = "0.4.3";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Matrix Chat Bridge",
  description:
    "Bridges Matrix rooms/DMs to Paperclip agents, one endpoint per agent (like the Slack connector): each endpoint binds a Matrix bot account to an agent and a room allowlist. Inbound messages become agent-session prompts; the agent's final reply is posted back. Zero-dependency Matrix sync client runs inside the worker.",
  author: "namhtpyn",
  categories: ["connector", "automation"],
  capabilities: [
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "events.subscribe",
    "activity.log.write",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["homeserverUrl", "endpoints"],
    properties: {
      homeserverUrl: {
        type: "string",
        title: "Homeserver URL",
        description: "Base URL of the Matrix homeserver, e.g. https://matrix.example.com",
      },
      wakeOn: {
        type: "string",
        enum: ["mention", "all"],
        title: "Default wake policy",
        description: "mention: wake the agent only when mentioned/replied-to. all: wake on every message. Endpoints may override.",
        default: "mention",
      },
      commandPrefix: {
        type: "string",
        title: "Command prefix (locked)",
        description: "Locked to \"!\". Commands: !status (per-bridge status; add @<bot> to target one), !new / !new-session (reset that room's session). Bare commands are answered by every bridge in the room; appending @<bot> (or prefixing it) targets a single bot.",
        enum: ["!"],
        default: "!",
      },
      endpoints: {
        type: "array",
        title: "Agent endpoints",
        description: "One entry per agent: its own Matrix bot account + room allowlist. Commands in bridged rooms: !status, !new (target with @<bot>).",
        items: {
          type: "object",
          required: ["agentId", "accessToken"],
          properties: {
            agentId: { type: "string", title: "Paperclip agent UUID" },
            accessToken: {
              type: "string",
              format: "secret-ref",
              title: "Matrix bot access token",
              description: "Pick a stored secret (recommended) — the token never lands in plugin config. Plain string also accepted for local dev.",
            },
            listenRooms: { type: "array", items: { type: "string" }, title: "Room allowlist (IDs or aliases)" },
            wakeOn: { type: "string", enum: ["mention", "all"] },
          },
        },
      },
    },
  },
};

export default manifest;
