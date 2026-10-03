/**
 * Minimal Matrix client-server v3 client over fetch.
 * Zero runtime dependencies — runs inside the plugin worker.
 */

export interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  state_key?: string;
  content: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: { events: MatrixEvent[]; limited?: boolean; prev_batch?: string };
        state?: { events: MatrixEvent[] };
        account_data?: { events: MatrixEvent[] };
      }
    >;
    invite?: Record<string, unknown>;
    leave?: Record<string, unknown>;
  };
}

export class MatrixClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private userId: string | null = null;

  constructor(homeserverUrl: string, accessToken: string, private readonly fetchImpl: typeof fetch) {
    this.baseUrl = homeserverUrl.replace(/\/+$/, "");
    this.token = accessToken;
  }

  private async api<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
    const res = await this.fetchImpl(url.toString(), {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const err = parsed as { errcode?: string; error?: string } | null;
      throw new Error(
        `Matrix ${method} ${path} -> ${res.status}: ${err?.errcode ?? ""} ${err?.error ?? text.slice(0, 200)}`,
      );
    }
    return parsed as T;
  }

  async whoami(): Promise<{ user_id: string }> {
    const r = await this.api<{ user_id: string }>("GET", "/_matrix/client/v3/account/whoami");
    this.userId = r.user_id;
    return r;
  }

  async sync(since: string | undefined, timeoutMs: number, filter?: string): Promise<SyncResponse> {
    // Server-side long-poll timeout must be lower than our fetch timeout.
    const serverTimeout = Math.max(1000, Math.floor(timeoutMs / 2));
    return this.api<SyncResponse>("GET", "/_matrix/client/v3/sync", {
      query: {
        timeout: String(serverTimeout),
        ...(since ? { since } : {}),
        ...(filter ? { filter } : {}),
      },
      timeoutMs,
    });
  }

  async sendMessage(roomId: string, body: string, formattedBody?: string): Promise<{ event_id: string }> {
    return this.api<{ event_id: string }>("PUT", "/_matrix/client/v3/rooms/" + encodeURIComponent(roomId) + "/send/m.room.message/" + this.txnId(), {
      body: {
        msgtype: "m.text",
        body,
        ...(formattedBody
          ? { format: "org.matrix.custom.html", formatted_body: formattedBody }
          : {}),
      },
      timeoutMs: 15_000,
    });
  }

  async resolveAlias(alias: string): Promise<{ room_id: string }> {
    return this.api<{ room_id: string }>("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`);
  }

  async joinRoom(roomIdOrAlias: string): Promise<{ room_id: string }> {
    const path = roomIdOrAlias.startsWith("#")
      ? `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`
      : `/_matrix/client/v3/rooms/${encodeURIComponent(roomIdOrAlias)}/join`;
    return this.api<{ room_id: string }>("POST", path, { timeoutMs: 15_000 });
  }

  async joinedRooms(): Promise<{ joined_rooms: string[] }> {
    return this.api<{ joined_rooms: string[] }>("GET", "/_matrix/client/v3/joined_rooms");
  }

  async roomStateEvent(roomId: string, type: string, stateKey = ""): Promise<Record<string, unknown> | null> {
    try {
      return await this.api<Record<string, unknown>>(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
      );
    } catch {
      return null;
    }
  }

  private txnCounter = 0;
  private txnStart = Date.now();
  private txnId(): string {
    this.txnCounter += 1;
    return `pcmatrix-${this.txnStart}-${this.txnCounter}`;
  }

  get selfUserId(): string | null {
    return this.userId;
  }
}

/** Best-effort plain-text extraction from an m.room.message content. */
export function messageBody(ev: MatrixEvent): string | null {
  if (ev.type !== "m.room.message") return null;
  const content = ev.content as { msgtype?: string; body?: string };
  if (!content || content.msgtype !== "m.text" || typeof content.body !== "string") return null;
  return content.body;
}

/** True when the event mentions userId via m.mentions or inline @pill in body. */
export function mentionsUser(ev: MatrixEvent, userId: string, body: string): boolean {
  const content = ev.content as { "m.mentions"?: { user_ids?: string[] } };
  const m = content?.["m.mentions"];
  if (m && Array.isArray(m.user_ids) && m.user_ids.includes(userId)) return true;
  const localpart = userId.split(":")[0].replace("@", "");
  const sig = `@${localpart}`;
  return body.includes(sig) || body.includes(userId);
}

/** Strip our own mention from the prompt body. */
export function stripMention(body: string, userId: string): string {
  const localpart = userId.split(":")[0].replace("@", "");
  let out = body.replace(new RegExp(`@${localpart}(:[a-zA-Z0-9.-]+)?`, "g"), "");
  out = out.replace(new RegExp(userId, "g"), "");
  return out.trim();
}
